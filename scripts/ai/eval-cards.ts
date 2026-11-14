/*
 * M3-02: can free models make good study cards from lecture slides?
 *
 *   npx tsx --env-file=.env.local scripts/ai/eval-cards.ts ~/ready-lectures --ai-allowed
 *   npx tsx scripts/ai/eval-cards.ts <folder> --fake          # proves the script with the fake AI, no keys
 *
 * Reads every PDF in <folder> (sorted by name; the first is "Lecture 1"), pulls the text per page
 * with the same code as the app (M2-09, `pagesFromBytes`), and asks every free model in the
 * `small` and `medium` lists (src/server/ai/providers.config.ts) for 12 cards per lecture,
 * using the prompt in scripts/ai/card-prompt.md. It measures, per model: valid JSON, cards that
 * pass the card schema, cards whose source slide exists and holds a key term of the answer,
 * duplicates, seconds per lecture, and how many lectures fit in the free daily limit.
 *
 * Writes <out>/card-eval.md (one table per model, 10 sample cards each, a pick) and
 * <out>/card-review.md (30 mixed cards with right / wrong / useless boxes, models hidden).
 * <out> is context/ai for a real run and .data/card-eval-fake for --fake.
 *
 * Privacy, on purpose:
 * - The PDFs are read in place. Neither they nor their text are copied anywhere; only the
 *   generated cards and the numbers are written, and those two files are not committed until
 *   Jazen has looked at them.
 * - Lecture text goes to a hosted model only with --ai-allowed, which says the course allows AI
 *   help (Aalto's rules, context/moodle/terms.md). Without it the script refuses a real run.
 * - Keys are read from the environment only and never printed. Models with no key are skipped.
 * - Only free models are called: the router refuses anything not in FREE_MODELS.
 */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { pagesFromBytes } from "@/server/files/extract";
import { PROVIDERS, type ProviderEntry, type SizeClass } from "@/server/ai/providers.config";
import { createRouter, AiBusy } from "@/server/ai/router";
import { createTestDb } from "@/server/db/test-db";
import type { Db } from "@/server/db/client";

// ---------- arguments ----------

type Args = {
  folder: string;
  fake: boolean;
  aiAllowed: boolean;
  count: number;
  maxChars: number;
  sizes: SizeClass[];
  out: string;
};

function usage(message?: string): never {
  if (message) console.error(`\n${message}\n`);
  console.error(
    [
      "Usage: npx tsx --env-file=.env.local scripts/ai/eval-cards.ts <folder of PDFs> --ai-allowed [options]",
      "       npx tsx scripts/ai/eval-cards.ts <folder of PDFs> --fake",
      "",
      "  --ai-allowed     required for a real run: the course these lectures belong to allows AI help",
      "  --fake           use the fake AI server instead of real providers (no keys, nothing leaves the machine)",
      "  --count N        cards per lecture (default 12)",
      "  --max-chars N    lecture text sent per request, in characters (default 16000, about 4,000 tokens;",
      "                   Groq's free plan allows 8,000 tokens a minute per model)",
      "  --sizes a,b      size classes to try (default small,medium)",
      "  --out DIR        where to write card-eval.md and card-review.md",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const rest = [...argv];
  let folder: string | undefined;
  const a: Omit<Args, "folder" | "out"> & { out?: string } = {
    fake: false,
    aiAllowed: false,
    count: 12,
    maxChars: 16_000,
    sizes: ["small", "medium"],
  };
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === "--fake") a.fake = true;
    else if (arg === "--ai-allowed") a.aiAllowed = true;
    else if (arg === "--count") a.count = positiveInt(rest.shift(), "--count");
    else if (arg === "--max-chars") a.maxChars = positiveInt(rest.shift(), "--max-chars");
    else if (arg === "--sizes") {
      const sizes = (rest.shift() ?? "").split(",").filter(Boolean);
      for (const s of sizes) if (!(s in PROVIDERS)) usage(`Unknown size class: ${s}`);
      a.sizes = sizes as SizeClass[];
    } else if (arg === "--out") a.out = rest.shift();
    else if (arg.startsWith("--")) usage(`Unknown option: ${arg}`);
    else if (!folder) folder = arg;
    else usage(`Only one folder, please (got a second: ${arg})`);
  }
  if (!folder) usage("Give the folder of lecture PDFs.");
  if (!a.fake && !a.aiAllowed) {
    usage(
      "Refusing a real run without --ai-allowed. Lecture text only goes to a hosted model for a course that allows AI help.",
    );
  }
  const root = process.cwd();
  const out = path.resolve(a.out ?? (a.fake ? path.join(root, ".data", "card-eval-fake") : path.join(root, "context", "ai")));
  return { ...a, folder: path.resolve(expandHome(folder)), out };
}

function positiveInt(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) usage(`${name} needs a positive whole number`);
  return n;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

// ---------- the card format (prototype main-flow.html, lines 2513 to 2571) ----------

const SOURCE_RE = /^Lecture (\d+), slides? (\d+)(?: (?:to|-|–) (\d+))?$/;

const base = {
  concept: z.string().min(1).max(60),
  rung: z.number().int().min(1).max(5),
  boss: z.boolean(),
  q: z.string().min(8),
  why: z.string().min(1).optional(),
  source: z.string().regex(SOURCE_RE),
};

export const CardSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("basic"), ...base, a: z.string().min(1) }),
  z.object({ type: z.literal("cloze"), ...base, q: z.string().regex(/\{\{[^{}]+\}\}/, "cloze needs {{…}}") }),
  z.object({
    type: z.literal("mcq"),
    ...base,
    why: z.string().min(1),
    opts: z
      .array(z.tuple([z.string().min(1), z.boolean()]))
      .min(3)
      .max(5)
      .refine((o) => o.filter(([, ok]) => ok).length === 1, "exactly one option is right"),
  }),
  z.object({
    type: z.literal("match"),
    ...base,
    pairs: z.array(z.tuple([z.string().min(1), z.string().min(1)])).min(3).max(5),
  }),
  z.object({
    type: z.literal("explain"),
    ...base,
    rubric: z.array(z.tuple([z.string().min(1), z.array(z.string().min(1)).min(1)])).min(2).max(4),
    model: z.string().min(1),
  }),
]);
export type Card = z.infer<typeof CardSchema>;

// ---------- reading the lectures ----------

type Lecture = { n: number; title: string; pages: { page: number; text: string }[] };

async function readLectures(folder: string): Promise<Lecture[]> {
  let names: string[];
  try {
    names = (await readdir(folder)).filter((f) => f.toLowerCase().endsWith(".pdf")).sort((x, y) => x.localeCompare(y));
  } catch {
    usage(`Cannot read the folder ${folder}`);
  }
  if (names.length === 0) usage(`No PDF files in ${folder}`);
  const lectures: Lecture[] = [];
  for (const [i, name] of names.entries()) {
    const bytes = new Uint8Array(await readFile(path.join(folder, name)));
    const pages = (await pagesFromBytes(bytes, "application/pdf")).filter((p) => p.text.trim().length > 0);
    lectures.push({ n: i + 1, title: name.replace(/\.pdf$/i, ""), pages });
  }
  return lectures;
}

/** The slides as the prompt shows them, cut at whole slides once `maxChars` is reached. */
function slidesText(lecture: Lecture, maxChars: number): { text: string; slides: number; cut: boolean } {
  const parts: string[] = [];
  let used = 0;
  for (const p of lecture.pages) {
    const block = `[Slide ${p.page}]\n${p.text.replace(/\s+\n/g, "\n").trim()}\n`;
    if (used + block.length > maxChars && parts.length > 0) {
      return { text: parts.join("\n"), slides: parts.length, cut: true };
    }
    parts.push(block.slice(0, maxChars));
    used += block.length;
  }
  return { text: parts.join("\n"), slides: parts.length, cut: false };
}

// ---------- the prompt ----------

type Prompt = { system: string; user: string };

async function loadPrompt(): Promise<Prompt> {
  const md = await readFile(path.join(import.meta.dirname, "card-prompt.md"), "utf8");
  const part = (heading: string) => {
    const at = md.indexOf(`## ${heading}`);
    const m = at >= 0 ? md.slice(at).match(/~~~\n([\s\S]*?)\n~~~/) : null;
    if (!m) throw new Error(`card-prompt.md has no fenced "${heading}" part`);
    return m[1];
  };
  return { system: part("System"), user: part("User") };
}

function fill(template: string, values: Record<string, string>): string {
  // Only the named slots; the {{like this}} in the cloze instructions stays as it is.
  return template.replace(/\{\{(lecture|title|slides|count)\}\}/g, (_, key: string) => values[key]);
}

// ---------- checking an answer ----------

const STOP = new Set(
  "about above after again against because before being below between both could does doing during each from further have having here into itself more most other over same should some such than that their theirs them then there these they this those through under until very were what when where which while whom with would your yours also only just like make made many much must need used uses using will".split(
    " ",
  ),
);

function keyTerms(card: Card): string[] {
  let answer: string;
  switch (card.type) {
    case "basic":
      answer = card.a;
      break;
    case "cloze":
      answer = [...card.q.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]).join(" ");
      break;
    case "mcq":
      answer = card.opts.find(([, ok]) => ok)?.[0] ?? "";
      break;
    case "match":
      answer = card.pairs.map(([t]) => t).join(" ");
      break;
    case "explain":
      answer = card.rubric.flatMap(([, kws]) => kws).join(" ");
      break;
  }
  const words = answer
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOP.has(w));
  return [...new Set(words)];
}

function normal(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

type SourceCheck = "ok" | "no_slide" | "no_term" | "wrong_lecture";

function checkSource(card: Card, lecture: Lecture): SourceCheck {
  const m = card.source.match(SOURCE_RE)!;
  if (Number(m[1]) !== lecture.n) return "wrong_lecture";
  const from = Number(m[2]);
  const to = m[3] ? Number(m[3]) : from;
  const pages = lecture.pages.filter((p) => p.page >= Math.min(from, to) && p.page <= Math.max(from, to));
  if (pages.length === 0) return "no_slide";
  const text = normal(pages.map((p) => p.text).join(" "));
  // A stem of 5 letters lets "governance" match "governed" and "prioritisation" match "prioritise".
  const terms = keyTerms(card);
  return terms.some((t) => text.includes(t.slice(0, Math.max(5, Math.min(t.length, 6))))) ? "ok" : "no_term";
}

function words(s: string): Set<string> {
  return new Set(normal(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
}

function isDuplicate(card: Card, earlier: Card[]): boolean {
  const a = words(card.q);
  return earlier.some((e) => {
    const b = words(e.q);
    const both = [...a].filter((w) => b.has(w)).length;
    const either = new Set([...a, ...b]).size;
    return either > 0 && both / either >= 0.8;
  });
}

/** The JSON object in a reply, allowing code fences or a sentence around it. */
function parseReply(text: string): { cards: unknown[] } | null {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const candidates = [unfenced, unfenced.slice(unfenced.indexOf("{"), unfenced.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as unknown;
      if (Array.isArray(v)) return { cards: v };
      if (v && typeof v === "object" && Array.isArray((v as { cards?: unknown }).cards)) {
        return { cards: (v as { cards: unknown[] }).cards };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ---------- running one model ----------

type CardResult = { card: Card; lecture: number; source: SourceCheck; duplicate: boolean };

type ModelRun = {
  entry: ProviderEntry;
  size: SizeClass;
  skipped?: string;
  calls: number;
  jsonOk: number;
  asked: number;
  returned: number;
  schemaOk: number;
  sourceOk: number;
  duplicates: number;
  seconds: number[];
  errors: string[];
  cards: CardResult[];
  tokensPerLecture: number[];
};

/** Free-plan daily limits beyond requests, from context/ai/providers.md (checked 2026-11-14). */
const TOKENS_PER_DAY: Partial<Record<ProviderEntry["provider"], number>> = { groq: 200_000 };
/** Pause between two calls to the same provider, so a run stays inside per-minute limits. */
const GAP_MS: Record<ProviderEntry["provider"], number> = { groq: 61_000, openrouter: 3_500, cloudflare: 1_000 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runModel(
  size: SizeClass,
  entry: ProviderEntry,
  lectures: Lecture[],
  prompt: Prompt,
  args: Args,
  deps: { env: Record<string, string | undefined>; baseUrlFor?: (e: ProviderEntry) => string; database: Db },
  lastCall: Map<string, number>,
): Promise<ModelRun> {
  const run: ModelRun = {
    entry,
    size,
    calls: 0,
    jsonOk: 0,
    asked: 0,
    returned: 0,
    schemaOk: 0,
    sourceOk: 0,
    duplicates: 0,
    seconds: [],
    errors: [],
    cards: [],
    tokensPerLecture: [],
  };
  if (!deps.env[entry.envKey] || (entry.accountEnvKey && !deps.env[entry.accountEnvKey])) {
    run.skipped = `no ${entry.envKey}${entry.accountEnvKey ? ` / ${entry.accountEnvKey}` : ""} in the environment`;
    return run;
  }
  const router = createRouter({
    providers: { small: [entry], medium: [], large: [] },
    env: deps.env,
    database: deps.database,
    baseUrlFor: deps.baseUrlFor,
  });

  for (const lecture of lectures) {
    const slides = slidesText(lecture, args.maxChars);
    const user = fill(prompt.user, {
      lecture: String(lecture.n),
      title: lecture.title,
      slides: slides.text,
      count: String(args.count),
    });
    if (!args.fake) {
      const wait = (lastCall.get(entry.provider) ?? 0) + GAP_MS[entry.provider] - Date.now();
      if (wait > 0) await sleep(wait);
    }
    run.calls += 1;
    run.asked += args.count;
    const started = Date.now();
    let text: string;
    try {
      ({ text } = await router.runText({
        size: "small",
        system: prompt.system,
        messages: [{ role: "user", content: user }],
        job: "eval-cards",
      }));
    } catch (error) {
      lastCall.set(entry.provider, Date.now());
      run.errors.push(`Lecture ${lecture.n}: ${error instanceof AiBusy ? "rate-limited or provider error" : (error as Error).name}`);
      continue;
    }
    lastCall.set(entry.provider, Date.now());
    run.seconds.push((Date.now() - started) / 1000);
    run.tokensPerLecture.push(Math.round((prompt.system.length + user.length + text.length) / 4));

    const parsed = parseReply(text);
    if (!parsed) continue;
    run.jsonOk += 1;
    run.returned += parsed.cards.length;
    const kept: Card[] = [];
    for (const raw of parsed.cards) {
      const checked = CardSchema.safeParse(raw);
      if (!checked.success) continue;
      const card = checked.data;
      run.schemaOk += 1;
      const source = checkSource(card, lecture);
      if (source === "ok") run.sourceOk += 1;
      const duplicate = isDuplicate(card, kept);
      if (duplicate) run.duplicates += 1;
      kept.push(card);
      run.cards.push({ card, lecture: lecture.n, source, duplicate });
    }
  }
  return run;
}

// ---------- the report ----------

const pct = (n: number, of: number) => (of === 0 ? "n/a" : `${Math.round((100 * n) / of)}%`);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

function lecturesPerDay(run: ModelRun): string {
  if (run.calls === 0) return "n/a";
  // One request per lecture (the app's runObject may add one repair request on a bad reply).
  const byRequests = run.entry.rpd === null ? Infinity : run.entry.rpd;
  const tpd = TOKENS_PER_DAY[run.entry.provider];
  const tokens = mean(run.tokensPerLecture);
  const byTokens = tpd && tokens > 0 ? tpd / tokens : Infinity;
  const fit = Math.floor(Math.min(byRequests, byTokens));
  if (!Number.isFinite(fit)) return "no request cap (Cloudflare: 10,000 Neurons a day, not measured here)";
  const why = byTokens < byRequests ? `tokens: ${tpd!.toLocaleString("en")} a day / about ${Math.round(tokens).toLocaleString("en")} per lecture` : `requests: ${run.entry.rpd} a day`;
  return `${fit} (${why})`;
}

function cardLine(r: CardResult): string {
  const c = r.card;
  const flag = r.source === "ok" ? "" : ` _(source check: ${r.source.replace("_", " ")})_`;
  const dup = r.duplicate ? " _(duplicate)_" : "";
  const head = `**${c.type}${c.boss ? ", boss" : ""}, rung ${c.rung}** · ${c.concept} · ${c.source}${flag}${dup}`;
  return [head, "", ...cardBody(c)].join("\n");
}

function cardBody(c: Card): string[] {
  const lines = [`Q: ${c.q}`];
  if (c.type === "basic") lines.push(`A: ${c.a}`);
  if (c.type === "mcq") for (const [t, ok] of c.opts) lines.push(`- ${ok ? "[x]" : "[ ]"} ${t}`);
  if (c.type === "match") for (const [t, m] of c.pairs) lines.push(`- ${t} → ${m}`);
  if (c.type === "explain") {
    for (const [label, kws] of c.rubric) lines.push(`- ${label} (${kws.join(", ")})`);
    lines.push(`Model answer: ${c.model}`);
  }
  if (c.why) lines.push(`Why: ${c.why}`);
  return lines.map((l) => (l.startsWith("- ") ? l : `${l}  `));
}

function pick(runs: ModelRun[]): string {
  const ran = runs.filter((r) => !r.skipped && r.calls > 0);
  const passing = ran.filter((r) => r.asked > 0 && r.schemaOk / r.asked >= 0.8);
  if (passing.length === 0) {
    return ran.length === 0
      ? "**No pick: no model could be run** (no keys in the environment)."
      : "**No pick: none of the models passed 80% schema-valid cards.**";
  }
  const score = (r: ModelRun) => (r.sourceOk - r.duplicates) / r.asked;
  const best = [...passing].sort((a, b) => score(b) - score(a))[0];
  return `**Pick: \`${best.entry.provider}:${best.entry.model}\`** (${best.size}): ${pct(best.schemaOk, best.asked)} schema-valid, ${pct(best.sourceOk, best.asked)} with a source slide that holds a key term, ${best.duplicates} duplicates. Read the sample cards and \`card-review.md\` before trusting it: the numbers say the cards are well formed and grounded, not that they are good questions.`;
}

function evalReport(runs: ModelRun[], lectures: Lecture[], args: Args): string {
  const date = new Date().toISOString().slice(0, 10);
  const out: string[] = [
    "# Card eval: can free models make good cards from lecture slides?",
    "",
    args.fake
      ? "> **FAKE RUN.** Every answer came from the fake AI server (tests/fake-ai/server.ts). These numbers prove the script, not the models."
      : `> Real run on ${date}. ${lectures.length} lecture PDF(s) read from a folder outside the repo; neither the PDFs nor their text are stored here. Not committed until Jazen has looked.`,
    "",
    `Made by \`scripts/ai/eval-cards.ts\` with \`scripts/ai/card-prompt.md\`. ${args.count} cards asked per lecture, up to ${args.maxChars.toLocaleString("en")} characters of slide text per request. Lectures: ${lectures
      .map((l) => `${l.n} (${l.pages.length} slides with text${slidesText(l, args.maxChars).cut ? `, cut to ${slidesText(l, args.maxChars).slides}` : ""})`)
      .join(", ")}.`,
    "",
    pick(runs),
    "",
    "What the columns mean: **valid JSON** is replies that parsed at all. **Schema-valid** is cards that match the card format, out of the cards asked for. **Grounded** is schema-valid cards whose `source` names a slide that exists and contains at least one key term of the answer. **Duplicates** are cards whose question shares 80% of its words with an earlier card of the same lecture.",
    "",
  ];
  for (const r of runs) {
    out.push(`## ${r.entry.provider}: \`${r.entry.model}\` (${r.size})`, "");
    if (r.skipped) {
      out.push(`Skipped: ${r.skipped}.`, "");
      continue;
    }
    out.push(
      "| Measure | Value |",
      "|---|---|",
      `| Valid JSON replies | ${r.jsonOk} of ${r.calls} (${pct(r.jsonOk, r.calls)}) |`,
      `| Cards returned | ${r.returned} of ${r.asked} asked |`,
      `| Schema-valid cards | ${r.schemaOk} of ${r.asked} (${pct(r.schemaOk, r.asked)}) |`,
      `| Grounded (source slide holds a key term) | ${r.sourceOk} of ${r.asked} (${pct(r.sourceOk, r.asked)}) |`,
      `| Duplicates | ${r.duplicates} |`,
      `| Seconds per lecture | ${r.seconds.length ? mean(r.seconds).toFixed(1) : "n/a"} |`,
      `| Lectures that fit in the free daily limit | ${lecturesPerDay(r)} |`,
      "",
    );
    if (r.errors.length) out.push(`Errors: ${r.errors.join("; ")}.`, "");
    const samples = sample(r.cards, 10);
    if (samples.length) {
      out.push("Sample cards:", "");
      for (const [i, c] of samples.entries()) out.push(`${i + 1}. ${cardLine(c).replace(/\n/g, "\n   ")}`, "");
    }
  }
  return out.join("\n");
}

/** Up to `n` cards spread over the list, so samples are not all from Lecture 1. */
function sample<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]);
}

function reviewSheet(runs: ModelRun[], args: Args): string {
  const pools = runs.filter((r) => r.cards.length).map((r) => ({ r, cards: sample(r.cards, 30) }));
  const mixed: { r: ModelRun; c: CardResult }[] = [];
  for (let i = 0; mixed.length < 30 && pools.some((p) => i < p.cards.length); i++) {
    for (const p of pools) if (i < p.cards.length && mixed.length < 30) mixed.push({ r: p.r, c: p.cards[i] });
  }
  const out = [
    "# Card review sheet",
    "",
    args.fake ? "> **FAKE RUN**: these cards came from the fake AI server." : "> Not committed until Jazen has looked.",
    "",
    "For each card tick one box: **right** (correct and worth studying), **wrong** (says something false or not in the lecture), **useless** (true but trivial, unclear, or not exam material). The model behind each card is in the key at the bottom; read it only after you are done.",
    "",
  ];
  for (const [i, { c }] of mixed.entries()) {
    out.push(`## ${i + 1}`, "", ...cardBody(c.card), `Source: ${c.card.source}`, "", "- [ ] right   - [ ] wrong   - [ ] useless", "");
  }
  out.push("## Key", "", "| Card | Model |", "|---|---|");
  for (const [i, { r }] of mixed.entries()) out.push(`| ${i + 1} | ${r.entry.provider}: ${r.entry.model} |`);
  return out.join("\n") + "\n";
}

// ---------- fake mode ----------

/** A well-formed reply built from the lecture's own slides, so the checks have something real to check. */
function fakeCards(lecture: Lecture, count: number): string {
  const pages = lecture.pages.length ? lecture.pages : [{ page: 1, text: "nothing" }];
  const cards = Array.from({ length: count }, (_, i) => {
    const p = pages[i % pages.length];
    const term = p.text.split(/\s+/).find((w) => w.replace(/\W/g, "").length >= 6)?.replace(/\W/g, "") ?? "example";
    const source = `Lecture ${lecture.n}, slide ${p.page}`;
    const common = { concept: `idea ${i % 4}`, rung: (i % 5) + 1, boss: i === 2, source, why: `Slide ${p.page} says so.` };
    switch (i % 5) {
      case 0:
        return { type: "basic", ...common, q: `Card ${i + 1}: what does slide ${p.page} say about ${term}?`, a: `It explains ${term}.` };
      case 1:
        return { type: "cloze", ...common, q: `Card ${i + 1}: slide ${p.page} is about {{${term}}}.` };
      case 2:
        return { type: "mcq", ...common, q: `Card ${i + 1}: which word appears on slide ${p.page}?`, opts: [[term, true], ["banana", false], ["bicycle", false], ["teapot", false]] };
      case 3:
        return { type: "match", ...common, q: `Card ${i + 1}: match the terms.`, pairs: [[term, "on the slide"], ["banana", "not on it"], ["teapot", "not on it either"]] };
      default:
        return { type: "explain", ...common, q: `Card ${i + 1}: explain ${term} in your own words.`, rubric: [["Names the idea", [term]], ["Says why it matters", ["matters"]]], model: `${term} matters because the slide says so.` };
    }
  });
  return JSON.stringify({ cards });
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [prompt, lectures] = await Promise.all([loadPrompt(), readLectures(args.folder)]);
  const testDb = await createTestDb(); // in memory: cool-downs and ai_calls rows of this run only
  const entries = args.sizes.flatMap((size) => PROVIDERS[size].map((entry) => ({ size, entry })));
  // The same model can sit in two size classes; try it once.
  const unique = entries.filter((e, i) => entries.findIndex((x) => x.entry.provider === e.entry.provider && x.entry.model === e.entry.model) === i);

  let env: Record<string, string | undefined> = process.env;
  let baseUrlFor: ((e: ProviderEntry) => string) | undefined;
  let stopFake: (() => Promise<void>) | undefined;
  if (args.fake) {
    const { startFakeAi } = await import("../../tests/fake-ai/server");
    const ai = await startFakeAi();
    stopFake = () => ai.close();
    // Each model gets its own route. Lecture by lecture, the fake answers with cards built from
    // the real slides; the last model also gets one broken reply, so the JSON check is exercised.
    const keys: Record<string, string> = {};
    for (const [i, { entry }] of unique.entries()) {
      const route = `m${i}`;
      keys[entry.envKey] = "fake-key";
      if (entry.accountEnvKey) keys[entry.accountEnvKey] = "fake-account";
      for (const [j, lecture] of lectures.entries()) {
        const broken = i === unique.length - 1 && j === 0;
        ai.queue(route, { text: broken ? '{"cards": [ {"type": "basic"' : fakeCards(lecture, args.count) });
      }
    }
    env = { ...keys };
    baseUrlFor = (e) => `${ai.url}/m${unique.findIndex((u) => u.entry.provider === e.provider && u.entry.model === e.model)}/v1`;
  }

  const lastCall = new Map<string, number>();
  const runs: ModelRun[] = [];
  try {
    for (const { size, entry } of unique) {
      process.stdout.write(`${entry.provider}:${entry.model} ... `);
      const run = await runModel(size, entry, lectures, prompt, args, { env, baseUrlFor, database: testDb.db }, lastCall);
      runs.push(run);
      console.log(run.skipped ? `skipped (${run.skipped})` : `${run.schemaOk}/${run.asked} schema-valid, ${run.sourceOk} grounded`);
    }
  } finally {
    await stopFake?.();
    await testDb.close();
  }

  await mkdir(args.out, { recursive: true });
  await writeFile(path.join(args.out, "card-eval.md"), evalReport(runs, lectures, args));
  await writeFile(path.join(args.out, "card-review.md"), reviewSheet(runs, args));
  console.log(`\nWrote ${path.join(args.out, "card-eval.md")} and card-review.md`);
  console.log(pick(runs).replace(/\*\*/g, "").replace(/`/g, ""));
}

main().catch((error: unknown) => {
  // Error names and messages only; never a request body (it could hold lecture text) or a key.
  console.error(`eval-cards failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`);
  process.exit(1);
});

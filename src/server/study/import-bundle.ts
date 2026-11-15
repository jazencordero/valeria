/**
 * Import a hand-made study bundle into one user's account (ticket M3-51).
 *
 *   const bundle = await loadBundle(root, { courses: ["TST-E0001"] }); // read + validate, no db
 *   const plans = bundle.courses.map(planImport);                    // pure
 *   const result = await applyImport(db, userId, plans[0], { dryRun: true });
 *
 * Layout. A bundle root is either one course (it holds `seed.json`) or a folder of course
 * subfolders (`<root>/<CODE>/seed.json`), each the same shape as a one-course bundle. A course
 * folder holds:
 * - `seed.json`: `{ exam: {courseCode, title, kind, at, targetPct | gradeTarget, startNewOn?},
 *   concepts: [{slug, name, lecture, position, weight}], lectures: [{n, title, file, deck, page}],
 *   map?, startNewOn? }`. Weights are renormalised to sum to 1. `gradeTarget` 1..5 becomes
 *   `target_pct` with the M3-13 scale (`targetPctForGrade`).
 * - one deck file per lecture: an array of cards in the M3-49 format (`parseCard`); `concept` /
 *   `concepts` hold slugs from seed.json. An optional `id` is the card's stable id.
 * - one page per lecture in the M9-05 shape stored in `lecture_content`.
 * - optional `map.json` (named by `seed.map`): `prerequisites` (slug -> slugs), `threads`,
 *   `studyOrder` (lecture groups, then e.g. "Exam essentials").
 * - optional `exam/`: exam documents, validated and counted (there is no table for them).
 * The root may hold `account.json`: `{ courses: { <code>: { aiAllowed, scope } } }`.
 *
 * Matching rules (so a second run changes nothing):
 * - Course: one of the user's courses whose `code` equals `courseCode` (trimmed, any case).
 *   Never created: `courses.moodle_id` is NOT NULL, so sync Moodle first. Several matches
 *   (an old and a new instance of a retake) is an error unless `courseId` picks one.
 * - Exam: same course + same title. An existing one is left as it is (a difference is a note).
 * - Concepts: same exam + same name (the schema has no slug column; slug -> id lives in memory).
 *   An existing concept gets the bundle's position, weight and lecture when they differ (updated).
 * - Concept position: the order in `map.studyOrder` when there is one, else the seed's.
 * - Lectures: same course + same `n`. An existing lecture keeps its title and file.
 * - Page: `source_hash` = sha256 of the page's canonical JSON. Same: skipped. Different: replaced.
 * - Lecture concepts: each concept whose `lecture` is one of the bundle's lectures is linked.
 * - Cards, in this order: (1) a card with the same stable `id` in this exam is the same card;
 *   same `content_hash` -> skipped, edited -> updated in place (memory kept, links replaced);
 *   (2) else the same `content_hash` anywhere in her account (the schema's unique key) ->
 *   skipped; (3) else created with `origin 'manual'`, `card_concepts` links and a fresh
 *   `card_states` row due at max(now, `startNewOn` 00:00 Helsinki). The stable id is kept in
 *   `body.importId`: the schema has no column for it.
 * - AI policy: account.json `aiAllowed` true/false -> `courses.ai_policy` allowed/not_allowed.
 *
 * Problems (a card skipped, and why) name the file and the card's position, never its text.
 * Notes say what the bundle holds that the schema or M3-49 cannot store. Writes are batched;
 * `applyImport` runs in one transaction (a savepoint when called inside one), and `dryRun`
 * does every write and then rolls back.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson, contentHash, parseCard, type Card } from "@/lib/study/card-schema";
import { newCard } from "@/lib/study/memory";
import type { Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { lectureConcepts, lectureContent, lectures } from "@/server/db/schema/learn";
import { cardConcepts, cards, cardStates, concepts, EXAM_KINDS, exams } from "@/server/db/schema/study";
import { helsinkiToInstant, targetPctForGrade, type TargetGrade } from "@/server/study/exams";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const nonEmpty = (what: string) =>
  z.string({ error: `${what} must be text.` }).trim().min(1, { error: `${what} is empty.` });

const fileName = (what: string) =>
  nonEmpty(what).refine((f) => !path.isAbsolute(f) && !f.split(/[\\/]/).includes(".."), {
    error: `${what} must be a file inside the course folder.`,
  });

const day = (what: string) =>
  z
    .string({ error: `${what} must be a date, YYYY-MM-DD.` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, { error: `${what} must be a date, YYYY-MM-DD.` })
    .refine((d) => helsinkiToInstant(d, "00:00") !== null, { error: `${what} is not a real date.` });

export const SeedSchema = z
  .object({
    exam: z.object({
      courseCode: nonEmpty("exam.courseCode"),
      title: nonEmpty("exam.title"),
      kind: z.enum(EXAM_KINDS, { error: `exam.kind must be one of ${EXAM_KINDS.join(", ")}.` }),
      at: z
        .string({ error: "exam.at must be an ISO date and time." })
        .refine((s) => !Number.isNaN(Date.parse(s)), { error: "exam.at must be an ISO date and time." }),
      targetPct: z.number().int().min(0).max(100).optional(),
      gradeTarget: z
        .number({ error: "exam.gradeTarget must be a grade from 1 to 5." })
        .int({ error: "exam.gradeTarget must be a grade from 1 to 5." })
        .min(1, { error: "exam.gradeTarget must be a grade from 1 to 5." })
        .max(5, { error: "exam.gradeTarget must be a grade from 1 to 5." })
        .optional(),
      startNewOn: day("exam.startNewOn").optional(),
    }),
    startNewOn: day("startNewOn").optional(),
    map: fileName("The map").optional(),
    concepts: z
      .array(
        z.object({
          slug: nonEmpty("Each concept slug"),
          name: nonEmpty("Each concept name"),
          lecture: z.union([z.number().int(), z.string().trim().min(1)]).optional(),
          position: z.number().int().min(0).optional(),
          weight: z.number().positive({ error: "Each concept weight must be above 0." }),
        }),
      )
      .min(1, { error: "The seed needs at least one concept." }),
    lectures: z.array(
      z.object({
        n: z.number().int().min(1, { error: "Each lecture number n must be 1 or more." }),
        title: nonEmpty("Each lecture title"),
        file: z.string().optional(),
        deck: fileName("A lecture's deck").optional(),
        page: fileName("A lecture's page").optional(),
      }),
    ),
  })
  .superRefine((seed, ctx) => {
    const dup = (list: (string | number)[]) => [...new Set(list.filter((v, i) => list.indexOf(v) !== i))];
    for (const s of dup(seed.concepts.map((c) => c.slug))) ctx.addIssue(`Concept slug "${s}" is used twice.`);
    for (const s of dup(seed.concepts.map((c) => c.name))) ctx.addIssue(`Concept name "${s}" is used twice.`);
    for (const n of dup(seed.lectures.map((l) => l.n))) ctx.addIssue(`Lecture ${n} is listed twice.`);
    const { targetPct, gradeTarget } = seed.exam;
    if (targetPct !== undefined && gradeTarget !== undefined && targetPctForGrade(gradeTarget as TargetGrade) !== targetPct) {
      ctx.addIssue("exam.targetPct and exam.gradeTarget disagree; give one of them.");
    }
    if (seed.startNewOn && seed.exam.startNewOn && seed.startNewOn !== seed.exam.startNewOn) {
      ctx.addIssue("startNewOn and exam.startNewOn disagree; give one of them.");
    }
  });
export type Seed = z.infer<typeof SeedSchema>;

export const DeckFileSchema = z.array(z.unknown(), { error: "A deck file must be a JSON array of cards." });

const Block = z.union(
  [
    z.tuple([z.literal("p"), z.string()]),
    z.tuple([z.literal("ul"), z.array(z.string())]),
    z.tuple([z.literal("dl"), z.array(z.tuple([z.string(), z.string()]))]),
  ],
  { error: "Each block must be ['p', text], ['ul', [items]] or ['dl', [[term, definition]]]." },
);

export const PageSchema = z.object({
  breath: nonEmpty("breath"),
  minutes: z.number().int().positive({ error: "minutes must be a whole number above 0." }),
  sections: z
    .array(
      z.object({
        heading: nonEmpty("Each section heading"),
        blocks: z.array(Block),
        terms: z.array(z.string()).default([]),
        slides: z.string().optional(),
      }),
    )
    .min(1, { error: "A page needs at least one section." }),
  slideTitles: z.array(z.string()).default([]),
});
export type Page = z.infer<typeof PageSchema>;

const slugList = z.array(nonEmpty("Each concept slug"));
const StudyGroup = z.object({
  lecture: z.union([z.number().int(), z.string()]).optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  concepts: slugList,
});

export const MapSchema = z.object({
  prerequisites: z.record(z.string(), slugList, { error: "prerequisites must map a concept slug to a list of slugs." }).default({}),
  threads: z
    .union(
      [
        z.array(z.looseObject({ name: z.string().optional(), title: z.string().optional(), concepts: slugList })),
        z.record(z.string(), slugList),
      ],
      { error: "threads must be a list of {name, concepts} or a map of name to slugs." },
    )
    .default([]),
  studyOrder: z
    .array(z.union([nonEmpty("Each studyOrder slug"), StudyGroup]), {
      error: "studyOrder must be a list of slugs or of groups {lecture or name, concepts}.",
    })
    .default([]),
  startNewOn: day("map.startNewOn").optional(),
});
export type StudyMap = z.infer<typeof MapSchema>;

export const AccountSchema = z.object({
  courses: z
    .record(
      z.string(),
      z.looseObject({
        aiAllowed: z.boolean({ error: "aiAllowed must be true or false." }).optional(),
        scope: z.string().optional(),
      }),
    )
    .default({}),
});
export type Account = z.infer<typeof AccountSchema>;

// ---------------------------------------------------------------------------
// loadBundle: read and validate the files (no database)
// ---------------------------------------------------------------------------

export type BundleDeck = { lecture: number; file: string; cards: unknown[] };
export type BundlePage = { lecture: number; file: string; page: Page };
export type ExamDoc = { file: string; kind: "pdf" | "json" | "text"; bytes: number };

/** One course of a bundle. `dir` is its folder; file names in problems are relative to it. */
export type CourseBundle = {
  dir: string;
  seed: Seed;
  map: StudyMap | null;
  decks: BundleDeck[];
  pages: BundlePage[];
  examDocs: ExamDoc[];
  /** Exam documents that could not be used: file and reason. */
  examDocProblems: { file: string; reason: string }[];
  /** From account.json, when it names this course. */
  account: { aiAllowed?: boolean; scope?: string; other: string[] } | null;
};

export type Bundle = { root: string; courses: CourseBundle[] };

/** The bundle cannot be used at all: every reason, one sentence each. */
export class BundleInvalid extends Error {
  constructor(readonly problems: string[]) {
    super(`The bundle cannot be imported:\n- ${problems.join("\n- ")}`);
    this.name = "BundleInvalid";
  }
}

function issues(file: string, error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const at = i.path.length ? ` (at ${i.path.join(".")})` : "";
    return `${file}${at}: ${i.message}`;
  });
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function readJson(dir: string, file: string, problems: string[], label = file): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path.join(dir, file), "utf8");
  } catch {
    problems.push(`${label}: cannot be read (missing?).`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    problems.push(`${label}: is not valid JSON.`);
    return undefined;
  }
}

const normCode = (s: string) => s.trim().toUpperCase();

/** Every file under `dir`, relative to it, sorted. */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

async function loadExamDocs(dir: string): Promise<Pick<CourseBundle, "examDocs" | "examDocProblems">> {
  const examDir = path.join(dir, "exam");
  const examDocs: ExamDoc[] = [];
  const examDocProblems: CourseBundle["examDocProblems"] = [];
  if (!(await exists(examDir))) return { examDocs, examDocProblems };
  for (const rel of await listFiles(examDir)) {
    const file = `exam/${rel}`;
    const bytes = await readFile(path.join(examDir, rel));
    const ext = path.extname(rel).toLowerCase();
    if (bytes.length === 0) {
      examDocProblems.push({ file, reason: "is empty." });
    } else if (ext === ".pdf") {
      if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") examDocs.push({ file, kind: "pdf", bytes: bytes.length });
      else examDocProblems.push({ file, reason: "is named .pdf but is not a PDF." });
    } else if (ext === ".json") {
      try {
        JSON.parse(bytes.toString("utf8"));
        examDocs.push({ file, kind: "json", bytes: bytes.length });
      } catch {
        examDocProblems.push({ file, reason: "is not valid JSON." });
      }
    } else if ([".md", ".txt", ".html", ".htm", ".csv"].includes(ext)) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (text.includes("�")) examDocProblems.push({ file, reason: "is not valid UTF-8 text." });
      else if (text.trim() === "") examDocProblems.push({ file, reason: "is empty." });
      else examDocs.push({ file, kind: "text", bytes: bytes.length });
    } else {
      examDocProblems.push({ file, reason: `has a type the importer does not know (${ext || "no extension"}).` });
    }
  }
  return { examDocs, examDocProblems };
}

async function loadCourse(dir: string, label: string, seed: Seed, account: Account | null, problems: string[]): Promise<CourseBundle> {
  const at = (f: string) => (label ? `${label}/${f}` : f);
  const decks: BundleDeck[] = [];
  const pages: BundlePage[] = [];
  for (const lecture of seed.lectures) {
    if (lecture.deck) {
      const raw = await readJson(dir, lecture.deck, problems, at(lecture.deck));
      if (raw !== undefined) {
        const deck = DeckFileSchema.safeParse(raw);
        if (deck.success) decks.push({ lecture: lecture.n, file: lecture.deck, cards: deck.data });
        else problems.push(...issues(at(lecture.deck), deck.error));
      }
    }
    if (lecture.page) {
      const raw = await readJson(dir, lecture.page, problems, at(lecture.page));
      if (raw !== undefined) {
        const page = PageSchema.safeParse(raw);
        if (page.success) pages.push({ lecture: lecture.n, file: lecture.page, page: page.data });
        else problems.push(...issues(at(lecture.page), page.error));
      }
    }
  }

  let map: StudyMap | null = null;
  if (seed.map) {
    const raw = await readJson(dir, seed.map, problems, at(seed.map));
    if (raw !== undefined) {
      const parsed = MapSchema.safeParse(raw);
      if (parsed.success) map = parsed.data;
      else problems.push(...issues(at(seed.map), parsed.error));
    }
  }
  const starts = [seed.startNewOn, seed.exam.startNewOn, map?.startNewOn].filter((d): d is string => !!d);
  if (new Set(starts).size > 1) problems.push(`${at(seed.map ?? "seed.json")}: startNewOn is given twice with different dates.`);

  const entry = account
    ? Object.entries(account.courses).find(([code]) => normCode(code) === normCode(seed.exam.courseCode))?.[1]
    : undefined;
  const accountPart = entry
    ? {
        aiAllowed: entry.aiAllowed,
        scope: entry.scope,
        other: Object.keys(entry).filter((k) => k !== "aiAllowed" && k !== "scope"),
      }
    : null;

  return { dir, seed, map, decks, pages, ...(await loadExamDocs(dir)), account: accountPart };
}

/**
 * Reads a bundle: `root/seed.json` (one course) or `root/<sub>/seed.json` (one course per
 * subfolder). With `courses`, only courses whose code is listed are read and validated, so a
 * course that is not ready yet does not block the others. Throws `BundleInvalid` with every problem.
 */
export async function loadBundle(root: string, options: { courses?: string[] } = {}): Promise<Bundle> {
  const problems: string[] = [];
  const wanted = options.courses?.length ? new Set(options.courses.map(normCode)) : null;

  let account: Account | null = null;
  if (await exists(path.join(root, "account.json"))) {
    const raw = await readJson(root, "account.json", problems);
    if (raw !== undefined) {
      const parsed = AccountSchema.safeParse(raw);
      if (parsed.success) account = parsed.data;
      else problems.push(...issues("account.json", parsed.error));
    }
  }

  // Where the seeds are: the root itself, or its subfolders.
  const places: { dir: string; label: string }[] = [];
  if (await exists(path.join(root, "seed.json"))) {
    places.push({ dir: root, label: "" });
  } else {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      throw new BundleInvalid([`${root}: cannot be read (missing?).`]);
    }
    for (const e of entries.filter((d) => d.isDirectory() && !d.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
      if (await exists(path.join(root, e.name, "seed.json"))) places.push({ dir: path.join(root, e.name), label: e.name });
    }
    if (places.length === 0) throw new BundleInvalid([`${root}: has no seed.json and no course folder with one.`]);
  }

  const found: { dir: string; label: string; seed: Seed }[] = [];
  const codesSeen: string[] = [];
  for (const place of places) {
    const seedLabel = place.label ? `${place.label}/seed.json` : "seed.json";
    const raw = await readJson(place.dir, "seed.json", problems, seedLabel);
    if (raw === undefined) continue;
    // Filter on the code before validating, so a course that is not ready is never checked.
    const looseCode = (raw as { exam?: { courseCode?: unknown } })?.exam?.courseCode;
    const code = typeof looseCode === "string" ? normCode(looseCode) : null;
    if (code) codesSeen.push(code);
    if (wanted && (!code || !wanted.has(code))) continue;
    const parsed = SeedSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(...issues(seedLabel, parsed.error));
      continue;
    }
    found.push({ ...place, seed: parsed.data });
  }

  if (wanted) {
    for (const w of wanted) if (!codesSeen.includes(w)) problems.push(`No course ${w} in this bundle (it has ${codesSeen.join(", ") || "none"}).`);
  }
  const dupCodes = codesSeen.filter((c, i) => codesSeen.indexOf(c) !== i && (!wanted || wanted.has(c)));
  for (const c of new Set(dupCodes)) problems.push(`Course ${c} is in the bundle twice.`);
  if (problems.length) throw new BundleInvalid(problems);

  const coursesOut: CourseBundle[] = [];
  for (const f of found) coursesOut.push(await loadCourse(f.dir, f.label, f.seed, account, problems));
  if (problems.length) throw new BundleInvalid(problems);
  return { root, courses: coursesOut };
}

// ---------------------------------------------------------------------------
// planImport: pure
// ---------------------------------------------------------------------------

/** A card or other item that was skipped or needs a look. Never quotes the card's text. */
export type ImportProblem = {
  /** The file it came from, relative to the course folder, e.g. "deck-1.json". */
  file: string;
  lecture?: number;
  /** 1-based position of the card in its deck file. */
  index?: number;
  reason: string;
};

export type PlannedConcept = {
  slug: string;
  name: string;
  lecture: string | null;
  position: number;
  /** Renormalised: all weights of the plan sum to 1. */
  weight: number;
};

export type PlannedLecture = { n: number; title: string; page: Page | null; pageHash: string | null };

export type PlannedCard = {
  lecture: number;
  file: string;
  index: number;
  card: Card;
  hash: string;
  /** The card's stable id from the bundle, when it has one. */
  importId: string | null;
  /** Concept slugs, primary first (all known to the seed). */
  conceptSlugs: string[];
};

export type ImportPlan = {
  exam: { courseCode: string; title: string; kind: (typeof EXAM_KINDS)[number]; at: Date; targetPct: number };
  concepts: PlannedConcept[];
  lectures: PlannedLecture[];
  cards: PlannedCard[];
  /** New cards are not due before this instant (startNewOn, 00:00 Helsinki), or null. */
  startNewAt: Date | null;
  /** account.json for this course: the AI policy to write, or null to leave it. */
  aiPolicy: "allowed" | "not_allowed" | null;
  problems: ImportProblem[];
  /** What the bundle holds that the schema or the M3-49 card format cannot store. */
  notes: string[];
};

/** The page's source hash: sha256 of its canonical JSON (key order and whitespace do not count). */
export function pageHash(page: Page): string {
  return createHash("sha256").update(canonicalJson(page)).digest("hex");
}

/** Card fields M3-49 has no place for; `parseCard` drops them. Counted and reported, never a failure. */
const UNSTORED_CARD_FIELDS = [
  ["accept", "also-accepted answers for a blank"],
  ["first", "marks the card that opens its concept"],
  ["beyondSlides", "says the card goes beyond the slides"],
  ["basis", "what the card is based on"],
  ["quote", "a quote from the slides"],
  ["fromFigure", "the figure the card comes from"],
] as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Concept slugs in study order (first appearance wins). */
function studyOrderSlugs(map: StudyMap): string[] {
  const out: string[] = [];
  for (const item of map.studyOrder) {
    for (const slug of typeof item === "string" ? [item] : item.concepts) if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

export function planImport(course: CourseBundle): ImportPlan {
  const { seed, map } = course;
  const problems: ImportProblem[] = [];
  const notes: string[] = [];

  // Concepts: weights renormalised; position from studyOrder when the map has one.
  const total = seed.concepts.reduce((s, c) => s + c.weight, 0);
  const slugs = new Set(seed.concepts.map((c) => c.slug));
  const ordered = map ? studyOrderSlugs(map) : [];
  const orderIndex = new Map(ordered.map((s, i) => [s, i + 1]));
  const plannedConcepts: PlannedConcept[] = seed.concepts.map((c, i) => ({
    slug: c.slug,
    name: c.name,
    lecture: c.lecture === undefined ? null : String(c.lecture),
    position: orderIndex.get(c.slug) ?? (ordered.length ? ordered.length + i + 1 : (c.position ?? i + 1)),
    weight: c.weight / total,
  }));

  if (map) {
    const mapFile = seed.map!;
    const unknownIn = (where: string, list: string[]) => {
      const bad = [...new Set(list.filter((s) => !slugs.has(s)))];
      if (bad.length) problems.push({ file: mapFile, reason: `${where} names unknown concept slugs ${bad.map((s) => `"${s}"`).join(", ")}.` });
    };
    unknownIn("prerequisites", [...Object.keys(map.prerequisites), ...Object.values(map.prerequisites).flat()]);
    const threadLists = Array.isArray(map.threads) ? map.threads.map((t) => t.concepts) : Object.values(map.threads);
    unknownIn("threads", threadLists.flat());
    unknownIn("studyOrder", ordered);
    if (ordered.length) {
      const missing = seed.concepts.filter((c) => !orderIndex.has(c.slug)).length;
      notes.push(
        `studyOrder sets the position of ${plural(ordered.filter((s) => slugs.has(s)).length, "concept")}` +
          (missing ? `; ${plural(missing, "concept")} not in it come after, in seed order.` : "."),
      );
      const groups = map.studyOrder.filter((g) => typeof g !== "string").length;
      if (groups) notes.push(`studyOrder groups (${plural(groups, "group")}, such as "Exam essentials") are not stored: no column for a study group.`);
    }
    const prereqs = Object.values(map.prerequisites).reduce((s, l) => s + l.length, 0);
    if (prereqs) notes.push(`prerequisites (${plural(prereqs, "link")}) are not stored: no table for concept prerequisites.`);
    if (threadLists.length) notes.push(`threads (${plural(threadLists.length, "thread")}) are not stored: no table for threads.`);
  }

  const pageOf = new Map(course.pages.map((p) => [p.lecture, p.page]));
  const plannedLectures: PlannedLecture[] = seed.lectures.map((l) => {
    const page = pageOf.get(l.n) ?? null;
    return { n: l.n, title: l.title, page, pageHash: page ? pageHash(page) : null };
  });

  // Cards.
  const plannedCards: PlannedCard[] = [];
  const seenHash = new Map<string, string>(); // hash -> "deck-1.json card 3"
  const seenId = new Map<string, string>();
  const unstored = new Map<string, number>();
  const firstPerConcept = new Map<string, number>();
  for (const deck of course.decks) {
    deck.cards.forEach((raw, i) => {
      const where = { file: deck.file, lecture: deck.lecture, index: i + 1 };
      const label = `${deck.file} card ${i + 1}`;
      if (isRecord(raw)) for (const [field] of UNSTORED_CARD_FIELDS) if (field in raw) unstored.set(field, (unstored.get(field) ?? 0) + 1);

      const parsed = parseCard(raw);
      if (!parsed.ok) {
        problems.push({ ...where, reason: parsed.problems.join(" ") });
        return;
      }
      const card = parsed.card;
      const unknown = card.concepts.filter((s) => !slugs.has(s));
      if (unknown.length) {
        problems.push({ ...where, reason: `Unknown concept slug ${unknown.map((s) => `"${s}"`).join(", ")}; it is not in seed.json.` });
        return;
      }

      let importId: string | null = null;
      const rawId = (raw as Record<string, unknown>).id;
      if (rawId !== undefined) {
        if ((typeof rawId !== "string" || rawId.trim() === "") && !Number.isInteger(rawId)) {
          problems.push({ ...where, reason: "The card id must be text or a whole number." });
          return;
        }
        importId = String(rawId).trim();
        const firstWithId = seenId.get(importId);
        if (firstWithId) {
          problems.push({ ...where, reason: `The card id "${importId}" is also used by ${firstWithId}; skipped.` });
          return;
        }
      }
      const hash = contentHash(card);
      const firstWithHash = seenHash.get(hash);
      if (firstWithHash) {
        problems.push({ ...where, reason: `Same card as ${firstWithHash}; skipped.` });
        return;
      }
      seenHash.set(hash, label);
      if (importId) seenId.set(importId, label);
      if ((raw as Record<string, unknown>).first === true) {
        firstPerConcept.set(card.concepts[0], (firstPerConcept.get(card.concepts[0]) ?? 0) + 1);
      }
      plannedCards.push({ ...where, card, hash, importId, conceptSlugs: card.concepts });
    });
  }
  for (const [field, why] of UNSTORED_CARD_FIELDS) {
    const n = unstored.get(field);
    if (n) notes.push(`"${field}" on ${plural(n, "card")} is not stored (${why}): the M3-49 card format has no field for it.`);
  }
  const manyFirsts = [...firstPerConcept].filter(([, n]) => n > 1).map(([s]) => s);
  if (manyFirsts.length) notes.push(`More than one "first" card for ${manyFirsts.map((s) => `"${s}"`).join(", ")}.`);
  if (plannedCards.some((c) => c.importId)) {
    notes.push("Card ids are kept in cards.body.importId and used to match on re-import: the schema has no column for them.");
  }

  // Exam target, study start, AI policy, exam documents.
  const { exam } = seed;
  const targetPct = exam.targetPct ?? (exam.gradeTarget ? targetPctForGrade(exam.gradeTarget as TargetGrade) : 80);
  const startDay = seed.startNewOn ?? exam.startNewOn ?? map?.startNewOn ?? null;
  const startNewAt = startDay ? helsinkiToInstant(startDay, "00:00") : null;
  if (startDay) {
    notes.push(`startNewOn ${startDay}: new cards are due from then; there is no course or exam column for a study start, so cards added later are not held back.`);
  }

  let aiPolicy: ImportPlan["aiPolicy"] = null;
  if (course.account) {
    if (course.account.aiAllowed !== undefined) aiPolicy = course.account.aiAllowed ? "allowed" : "not_allowed";
    if (course.account.scope !== undefined) {
      notes.push(`account.json AI scope "${course.account.scope}" is not stored: courses.ai_policy has no scope.`);
    }
    if (course.account.other.length) notes.push(`account.json fields ${course.account.other.join(", ")} are not stored.`);
  }

  if (course.examDocs.length || course.examDocProblems.length) {
    const kinds = ["pdf", "json", "text"]
      .map((k) => [k, course.examDocs.filter((d) => d.kind === k).length] as const)
      .filter(([, n]) => n)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");
    notes.push(
      `exam/ holds ${plural(course.examDocs.length, "valid document")}${kinds ? ` (${kinds})` : ""}, not imported: ` +
        "no table holds exam documents (course_files needs a Moodle ref and url; notes are her own writing).",
    );
    for (const p of course.examDocProblems) problems.push({ file: p.file, reason: p.reason });
  }

  return {
    exam: { courseCode: exam.courseCode, title: exam.title, kind: exam.kind, at: new Date(exam.at), targetPct },
    concepts: plannedConcepts,
    lectures: plannedLectures,
    cards: plannedCards,
    startNewAt,
    aiPolicy,
    problems,
    notes,
  };
}

// ---------------------------------------------------------------------------
// applyImport: one transaction, batched writes
// ---------------------------------------------------------------------------

export type Count = { created: number; skipped: number; updated: number };
export type ImportCounts = {
  exam: Count;
  concepts: Count;
  lectures: Count;
  pages: Count;
  lectureConcepts: Count;
  cards: Count;
  aiPolicy: Count;
};

export type ImportResult = {
  dryRun: boolean;
  courseCode: string;
  courseId: string;
  examId: string;
  counts: ImportCounts;
  /** The plan's problems plus those found while writing. */
  problems: ImportProblem[];
  notes: string[];
};

/** The import could not run (no such course, several courses). Nothing was written. */
export class ImportFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFailed";
  }
}

class DryRunRollback extends Error {
  constructor(readonly result: ImportResult) {
    super("dry run: rolled back");
  }
}

const zero = (): Count => ({ created: 0, skipped: 0, updated: 0 });
const CHUNK = 200;

function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The card's own fields (the prototype's CARD_DATA body) plus its stable id; shared fields have columns. */
function cardBody(p: PlannedCard): Record<string, unknown> {
  const { type: _type, concepts: _concepts, rung: _rung, boss: _boss, why: _why, source: _source, ...body } = p.card;
  void [_type, _concepts, _rung, _boss, _why, _source];
  return p.importId ? { ...body, importId: p.importId } : body;
}

function cardColumns(p: PlannedCard) {
  return {
    type: p.card.type,
    rung: p.card.rung ?? 0,
    boss: p.card.boss,
    body: cardBody(p),
    why: p.card.why ?? null,
    source: p.card.source,
    contentHash: p.hash,
  };
}

const sameNumber = (a: number, b: number) => Math.abs(a - b) < 1e-9;

export async function applyImport(
  database: Db,
  userId: string,
  plan: ImportPlan,
  options: { dryRun?: boolean; courseId?: string; now?: Date } = {},
): Promise<ImportResult> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const dueAt = plan.startNewAt && plan.startNewAt > now ? plan.startNewAt : now;

  try {
    return await database.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const counts: ImportCounts = {
        exam: zero(),
        concepts: zero(),
        lectures: zero(),
        pages: zero(),
        lectureConcepts: zero(),
        cards: zero(),
        aiPolicy: zero(),
      };
      const problems: ImportProblem[] = [...plan.problems];

      // Course: found, never created.
      const hers = await tx
        .select({ id: courses.id, code: courses.code, name: courses.name, hidden: courses.hidden, aiPolicy: courses.aiPolicy })
        .from(courses)
        .where(eq(courses.userId, userId));
      let matches = hers.filter((c) => c.code !== null && normCode(c.code) === normCode(plan.exam.courseCode));
      if (options.courseId) matches = matches.filter((c) => c.id === options.courseId);
      if (matches.length === 0) {
        throw new ImportFailed(
          `No course with code ${plan.exam.courseCode}${options.courseId ? ` and id ${options.courseId}` : ""} ` +
            "for this user. Sync Moodle first: a course cannot be created by hand (courses.moodle_id is required).",
        );
      }
      if (matches.length > 1) {
        const list = matches.map((c) => `${c.id} (${c.name}${c.hidden ? ", hidden" : ""})`).join("; ");
        throw new ImportFailed(`Several courses have code ${plan.exam.courseCode}: ${list}. Pick one with --course-id <id>.`);
      }
      const course = matches[0];
      const courseId = course.id;

      if (plan.aiPolicy) {
        if (course.aiPolicy === plan.aiPolicy) counts.aiPolicy.skipped += 1;
        else {
          await tx.update(courses).set({ aiPolicy: plan.aiPolicy }).where(eq(courses.id, courseId));
          counts.aiPolicy.updated += 1;
        }
      }

      // Exam: by course + title.
      const title = plan.exam.title.trim();
      const [existingExam] = await tx
        .select()
        .from(exams)
        .where(and(eq(exams.userId, userId), eq(exams.courseId, courseId), eq(exams.title, title)))
        .limit(1);
      let examId: string;
      if (existingExam) {
        examId = existingExam.id;
        counts.exam.skipped += 1;
        const differs =
          existingExam.at.getTime() !== plan.exam.at.getTime() ||
          existingExam.kind !== plan.exam.kind ||
          existingExam.targetPct !== plan.exam.targetPct;
        if (differs) {
          problems.push({
            file: "seed.json",
            reason: `The exam "${title}" already exists with a different date, kind or target; it was left as it is.`,
          });
        }
      } else {
        const [row] = await tx
          .insert(exams)
          .values({ userId, courseId, title, kind: plan.exam.kind, at: plan.exam.at, targetPct: plan.exam.targetPct })
          .returning({ id: exams.id });
        examId = row.id;
        counts.exam.created += 1;
      }

      // Concepts: by exam + name; slug -> id kept in memory.
      const conceptRows = await tx
        .select({ id: concepts.id, name: concepts.name, lecture: concepts.lecture, position: concepts.position, weight: concepts.weight })
        .from(concepts)
        .where(and(eq(concepts.userId, userId), eq(concepts.examId, examId)));
      const conceptByName = new Map(conceptRows.map((c) => [c.name.trim(), c]));
      const conceptIdOf = new Map<string, string>();
      const newConcepts: PlannedConcept[] = [];
      for (const c of plan.concepts) {
        const row = conceptByName.get(c.name.trim());
        if (!row) {
          newConcepts.push(c);
          continue;
        }
        conceptIdOf.set(c.slug, row.id);
        if (row.position === c.position && sameNumber(row.weight, c.weight) && row.lecture === c.lecture) {
          counts.concepts.skipped += 1;
        } else {
          await tx
            .update(concepts)
            .set({ position: c.position, weight: c.weight, lecture: c.lecture })
            .where(eq(concepts.id, row.id));
          counts.concepts.updated += 1;
        }
      }
      for (const part of chunks(newConcepts)) {
        const rows = await tx
          .insert(concepts)
          .values(part.map((c) => ({ userId, examId, name: c.name.trim(), lecture: c.lecture, position: c.position, weight: c.weight })))
          .returning({ id: concepts.id, name: concepts.name });
        const idOf = new Map(rows.map((r) => [r.name, r.id]));
        for (const c of part) conceptIdOf.set(c.slug, idOf.get(c.name.trim())!);
        counts.concepts.created += rows.length;
      }

      // Lectures: by course + n.
      const lectureRows = await tx
        .select({ id: lectures.id, n: lectures.n })
        .from(lectures)
        .where(and(eq(lectures.userId, userId), eq(lectures.courseId, courseId)));
      const lectureIdOf = new Map(lectureRows.map((l) => [l.n, l.id]));
      const newLectures = plan.lectures.filter((l) => !lectureIdOf.has(l.n));
      counts.lectures.skipped += plan.lectures.length - newLectures.length;
      if (newLectures.length) {
        const rows = await tx
          .insert(lectures)
          .values(newLectures.map((l) => ({ userId, courseId, n: l.n, title: l.title.trim() })))
          .returning({ id: lectures.id, n: lectures.n });
        for (const r of rows) lectureIdOf.set(r.n, r.id);
        counts.lectures.created += rows.length;
      }

      // Lecture pages.
      const withPage = plan.lectures.filter((l) => l.page && l.pageHash);
      const contentRows = withPage.length
        ? await tx
            .select({ id: lectureContent.id, lectureId: lectureContent.lectureId, sourceHash: lectureContent.sourceHash })
            .from(lectureContent)
            .where(inArray(lectureContent.lectureId, withPage.map((l) => lectureIdOf.get(l.n)!)))
        : [];
      const contentOf = new Map(contentRows.map((c) => [c.lectureId, c]));
      const newContent = [];
      for (const l of withPage) {
        const lectureId = lectureIdOf.get(l.n)!;
        const values = {
          breath: l.page!.breath,
          minutes: l.page!.minutes,
          sections: l.page!.sections,
          slideTitles: l.page!.slideTitles,
          sourceHash: l.pageHash!,
        };
        const content = contentOf.get(lectureId);
        if (!content) newContent.push({ lectureId, ...values });
        else if (content.sourceHash === l.pageHash) counts.pages.skipped += 1;
        else {
          await tx.update(lectureContent).set(values).where(eq(lectureContent.id, content.id));
          counts.pages.updated += 1;
        }
      }
      if (newContent.length) {
        await tx.insert(lectureContent).values(newContent);
        counts.pages.created += newContent.length;
      }

      // Lecture concepts: a concept's `lecture` names one of the bundle's lectures.
      const bundleLectures = new Set(plan.lectures.map((l) => l.n));
      const links = plan.concepts
        .filter((c) => c.lecture !== null && bundleLectures.has(Number(c.lecture)))
        .map((c) => ({ lectureId: lectureIdOf.get(Number(c.lecture))!, conceptId: conceptIdOf.get(c.slug)! }));
      for (const part of chunks(links)) {
        const made = await tx.insert(lectureConcepts).values(part).onConflictDoNothing().returning({ id: lectureConcepts.id });
        counts.lectureConcepts.created += made.length;
        counts.lectureConcepts.skipped += part.length - made.length;
      }

      // Cards: by stable id in this exam, then by content hash in her account.
      const existing = await tx
        .select({ id: cards.id, examId: cards.examId, hash: cards.contentHash, importId: sql<string | null>`${cards.body}->>'importId'` })
        .from(cards)
        .where(eq(cards.userId, userId));
      const byHash = new Map(existing.map((c) => [c.hash, c.id]));
      const byImportId = new Map(existing.filter((c) => c.importId && c.examId === examId).map((c) => [c.importId!, c]));

      const toInsert: PlannedCard[] = [];
      const toUpdate: { id: string; p: PlannedCard }[] = [];
      for (const p of plan.cards) {
        const same = p.importId ? byImportId.get(p.importId) : undefined;
        if (same) {
          if (same.hash === p.hash) counts.cards.skipped += 1;
          else if (byHash.has(p.hash)) {
            problems.push({
              file: p.file,
              lecture: p.lecture,
              index: p.index,
              reason: `Card "${p.importId}" was edited into a card she already has; left as it was.`,
            });
          } else {
            toUpdate.push({ id: same.id, p });
            byHash.delete(same.hash);
            byHash.set(p.hash, same.id);
          }
        } else if (byHash.has(p.hash)) counts.cards.skipped += 1;
        else {
          toInsert.push(p);
          byHash.set(p.hash, "pending");
        }
      }

      for (const { id, p } of toUpdate) {
        await tx.update(cards).set(cardColumns(p)).where(eq(cards.id, id));
        await tx.delete(cardConcepts).where(eq(cardConcepts.cardId, id));
        await tx.insert(cardConcepts).values(p.conceptSlugs.map((slug) => ({ cardId: id, conceptId: conceptIdOf.get(slug)! })));
        counts.cards.updated += 1;
      }

      const fresh = newCard(dueAt);
      for (const part of chunks(toInsert)) {
        const rows = await tx
          .insert(cards)
          .values(part.map((p) => ({ userId, examId, origin: "manual" as const, ...cardColumns(p) })))
          .returning({ id: cards.id, hash: cards.contentHash });
        const idOf = new Map(rows.map((r) => [r.hash, r.id]));
        await tx
          .insert(cardConcepts)
          .values(part.flatMap((p) => p.conceptSlugs.map((slug) => ({ cardId: idOf.get(p.hash)!, conceptId: conceptIdOf.get(slug)! }))));
        await tx.insert(cardStates).values(rows.map((r) => ({ cardId: r.id, fsrs: fresh, dueAt, lapses: 0 })));
        counts.cards.created += rows.length;
      }

      const result: ImportResult = {
        dryRun,
        courseCode: plan.exam.courseCode,
        courseId,
        examId,
        counts,
        problems,
        notes: plan.notes,
      };
      if (dryRun) throw new DryRunRollback(result);
      return result;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    throw err;
  }
}

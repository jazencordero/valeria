/**
 * Card format: one schema per card type (M3-49).
 *
 * The five card bodies are the prototype's `CARD_DATA` shapes
 * (context/tickets/prototype/main-flow.html, lines 2513 to 2571):
 *
 *   basic    { q, a }
 *   cloze    { q, accept? }            q holds one or more {{...}} blanks; accept: other
 *                                      answers per blank, { [blankAnswer]: string[] }
 *   mcq      { q, opts }               opts: [text, correct][], 2 to 4, exactly one correct
 *   match    { q, pairs, order }       pairs: [term, meaning][], 3 to 5;
 *                                      order: the order the meanings are shown in, as
 *                                      indexes into pairs (a permutation of 0..n-1)
 *   explain  { q, rubric, model }      rubric: [label, keywords[]][]; model: a model answer
 *
 * Shared fields, as read by `parseCard`:
 *
 *   type      one of the five above (same names as `CardType` in ./bite)
 *   concept   the concept id the card trains, and/or
 *   concepts  several concept ids (boss cards). Both are accepted on the way in and
 *             normalised to `concepts` (primary first, no duplicates). At least one.
 *   rung      optional ladder rung 1..5 (the prototype has none, so it is optional)
 *   boss      optional; normalised to a boolean, default false
 *   core      optional; the card is essential (studied before the concept's other
 *             cards, M3-52). Normalised to a boolean, default false
 *   first     optional; the card opens its concept (shown first when the concept is
 *             introduced, M3-52). Normalised to a boolean, default false
 *   why       optional explanation shown after answering
 *   source    required, where the card comes from ("Lecture 5, slide 11").
 *             The prototype calls it `src`; both names are accepted, `source` wins.
 *
 * Cloze `accept` (M3-52): each key must be one of the card's blank answers, compared
 * after trimming (a key that matches no blank is a problem, so a typo cannot silently
 * accept nothing). Keys are stored trimmed; two keys for the same blank are merged.
 * Each variant must be non-empty text. A blank with an empty list is allowed and
 * dropped, and `accept` is left out when nothing is left. `accept` on another card
 * type is dropped like any unknown field. Matching answers is `./cloze-match`.
 *
 * core, first and accept are not content: they never change `contentHash`.
 *
 * Anything else (the prototype's `st` scheduler state, for example) is dropped: memory
 * state lives with the learner, not in the card. Pure module: no Node or browser APIs,
 * so it runs in both.
 */
import { z } from "zod";
import type { CardType } from "./bite";

// ---------------------------------------------------------------------------
// Types (the normalised card that parseCard returns)
// ---------------------------------------------------------------------------

export const CARD_TYPES = ["basic", "cloze", "mcq", "match", "explain"] as const satisfies readonly CardType[];

/** Fails to compile if bite.ts gains a card type this module does not know. */
type _CoversAllTypes = CardType extends (typeof CARD_TYPES)[number] ? true : never;
const _coversAllTypes: _CoversAllTypes = true;
void _coversAllTypes;

export type CardRung = 1 | 2 | 3 | 4 | 5;

export type CardBase = {
  /** Concept ids this card trains. Primary first. Never empty. */
  concepts: string[];
  rung?: CardRung;
  boss: boolean;
  /** Essential card. Present only when true (so stored bodies of other cards do not change). */
  core?: true;
  /** Opens its concept. Present only when true. */
  first?: true;
  why?: string;
  source: string;
};

export type BasicCard = CardBase & { type: "basic"; q: string; a: string };
/** Other accepted answers per blank, keyed by the blank's answer (trimmed). */
export type ClozeAccept = Record<string, string[]>;
export type ClozeCard = CardBase & { type: "cloze"; q: string; accept?: ClozeAccept };
export type McqOption = [text: string, correct: boolean];
export type McqCard = CardBase & { type: "mcq"; q: string; opts: McqOption[] };
export type MatchPair = [term: string, meaning: string];
export type MatchCard = CardBase & { type: "match"; q: string; pairs: MatchPair[]; order: number[] };
export type RubricPoint = [label: string, keywords: string[]];
export type ExplainCard = CardBase & { type: "explain"; q: string; rubric: RubricPoint[]; model: string };

export type Card = BasicCard | ClozeCard | McqCard | MatchCard | ExplainCard;

export type ParseResult = { ok: true; card: Card } | { ok: false; problems: string[] };

// ---------------------------------------------------------------------------
// Plain-word names
// ---------------------------------------------------------------------------

const CARD_NOUN: Record<CardType, string> = {
  basic: "A recall card",
  cloze: "A fill-the-gap card",
  mcq: "A multiple-choice card",
  match: "A match card",
  explain: "An explain card",
};

const MCQ_MIN = 2;
const MCQ_MAX = 4;
const MATCH_MIN = 3;
const MATCH_MAX = 5;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Cloze blanks
// ---------------------------------------------------------------------------

const BLANK = /\{\{([\s\S]*?)\}\}/g;

/** The answers inside a cloze question's {{...}} blanks, in order. */
export function clozeBlanks(q: string): string[] {
  return Array.from(q.matchAll(BLANK), (m) => m[1]);
}

// ---------------------------------------------------------------------------
// Zod schemas: what a card looks like on the way in
// ---------------------------------------------------------------------------

const text = (what: string) =>
  z
    .string({ error: (iss) => (iss.input === undefined ? `${what} is missing.` : `${what} must be text.`) })
    .refine((s) => s.trim().length > 0, { error: `${what} is empty.` });

/** Shared fields as accepted on input (before normalising concept/src/boss). */
export const SharedFieldsSchema = z.object({
  concept: text("The concept").optional(),
  concepts: z.array(text("Each concept"), { error: "The concepts must be a list of concept ids." }).optional(),
  rung: z
    .number({ error: "The rung must be a whole number from 1 to 5." })
    .int({ error: "The rung must be a whole number from 1 to 5." })
    .min(1, { error: "The rung must be a whole number from 1 to 5." })
    .max(5, { error: "The rung must be a whole number from 1 to 5." })
    .optional(),
  boss: z.boolean({ error: "Boss must be true or false." }).optional(),
  core: z.boolean({ error: "Core must be true or false." }).optional(),
  first: z.boolean({ error: "First must be true or false." }).optional(),
  why: text("The explanation (why)").optional(),
  source: text("The source").optional(),
  src: text("The source").optional(),
});

export const BasicBodySchema = z.object({
  type: z.literal("basic"),
  q: text("The question"),
  a: text("The answer"),
});

export const ClozeBodySchema = z.object({
  type: z.literal("cloze"),
  q: text("The text").superRefine((q, ctx) => {
    const blanks = clozeBlanks(q);
    if (blanks.length === 0) {
      ctx.addIssue("A fill-the-gap card needs at least one blank written as {{answer}}; this one has none.");
      return;
    }
    const empty = blanks.filter((b) => b.trim() === "").length;
    if (empty > 0) {
      ctx.addIssue(`Every blank needs an answer inside the braces; ${plural(empty, "blank is", "blanks are")} empty.`);
    }
    const rest = q.replace(BLANK, "");
    if (rest.includes("{{") || rest.includes("}}")) {
      ctx.addIssue("The text has a {{ or }} that is not part of a complete {{answer}} blank.");
    }
  }),
  accept: z
    .record(
      z.string(),
      z.array(text("Each accepted answer"), { error: "Each blank's accepted answers must be a list of text." }),
      { error: "The accepted answers must be an object: { blank answer: [other answers] }." },
    )
    .optional(),
});

/** Every `accept` key must name one of the card's blanks (both trimmed). */
function checkClozeAccept(card: { q?: unknown; accept?: unknown }, ctx: z.RefinementCtx): void {
  if (typeof card.q !== "string" || !isRecord(card.accept)) return;
  const blanks = new Set(clozeBlanks(card.q).map((b) => b.trim()));
  for (const key of Object.keys(card.accept)) {
    if (!blanks.has(key.trim())) {
      ctx.addIssue({
        code: "custom",
        path: ["accept"],
        message: `The accepted answers name a blank "${key.trim()}" that is not in the text; each key must be the answer inside one of its {{...}} blanks.`,
      });
    }
  }
}

const mcqOption = z.tuple([text("Each option's text"), z.boolean({ error: "Each option must say true or false for correct." })], {
  error: "Each option must be a pair: [text, true or false].",
});

export const McqBodySchema = z.object({
  type: z.literal("mcq"),
  q: text("The question"),
  opts: z.array(mcqOption, { error: "A multiple-choice card needs a list of options." }).superRefine((opts, ctx) => {
    if (opts.length < MCQ_MIN || opts.length > MCQ_MAX) {
      ctx.addIssue(`A multiple-choice card needs ${MCQ_MIN} to ${MCQ_MAX} options; this one has ${opts.length}.`);
    }
    const correct = opts.filter((o) => o[1]).length;
    if (correct !== 1) {
      ctx.addIssue(`A multiple-choice card needs exactly one correct option; this one has ${correct}.`);
    }
  }),
});

const matchPair = z.tuple([text("Each term"), text("Each meaning")], {
  error: "Each pair must be [term, meaning].",
});

export const MatchBodySchema = z.object({
  type: z.literal("match"),
  q: text("The instruction"),
  pairs: z.array(matchPair, { error: "A match card needs a list of pairs." }).superRefine((pairs, ctx) => {
    if (pairs.length < MATCH_MIN || pairs.length > MATCH_MAX) {
      ctx.addIssue(`A match card needs ${MATCH_MIN} to ${MATCH_MAX} pairs; this one has ${pairs.length}.`);
    }
  }),
  order: z.array(z.number({ error: "The order must list pair numbers." }).int({ error: "The order must list whole pair numbers." }), {
    error: (iss) =>
      iss.input === undefined
        ? "A match card needs an order: the order its meanings are shown in."
        : "The order must be a list of pair numbers.",
  }),
});

/** `order` must name every pair once: it is the order the meanings are shown in. */
function checkMatchOrder(card: { pairs?: unknown; order?: unknown }, ctx: z.RefinementCtx): void {
  if (!Array.isArray(card.pairs) || !Array.isArray(card.order)) return;
  const n = card.pairs.length;
  const order = card.order as number[];
  const isPermutation = order.length === n && new Set(order).size === n && order.every((k) => k >= 0 && k < n);
  if (!isPermutation) {
    ctx.addIssue({
      code: "custom",
      path: ["order"],
      message: `The order must list every pair number from 0 to ${n - 1} once; this one is [${order.join(", ")}].`,
    });
  }
}

const rubricPoint = z.tuple(
  [
    text("Each rubric label"),
    z
      .array(text("Each keyword"), { error: "Each rubric point needs a list of keywords." })
      .min(1, { error: "Each rubric point needs at least one keyword." }),
  ],
  { error: "Each rubric point must be [label, [keywords]]." },
);

export const ExplainBodySchema = z.object({
  type: z.literal("explain"),
  q: text("The question"),
  rubric: z
    .array(rubricPoint, { error: "An explain card needs a rubric: a list of points to look for." })
    .min(1, { error: "An explain card needs at least one rubric point; this one has none." }),
  model: text("The model answer"),
});

/** Full input schema per card type: shared fields plus that type's body. */
export const CARD_SCHEMAS = {
  basic: SharedFieldsSchema.extend(BasicBodySchema.shape),
  cloze: SharedFieldsSchema.extend(ClozeBodySchema.shape).superRefine(checkClozeAccept),
  mcq: SharedFieldsSchema.extend(McqBodySchema.shape),
  match: SharedFieldsSchema.extend(MatchBodySchema.shape).superRefine(checkMatchOrder),
  explain: SharedFieldsSchema.extend(ExplainBodySchema.shape),
} as const;

// ---------------------------------------------------------------------------
// parseCard
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCardType(v: unknown): v is CardType {
  return typeof v === "string" && (CARD_TYPES as readonly string[]).includes(v);
}

function fieldName(path: PropertyKey[]): string {
  return path.map((p) => (typeof p === "number" ? `#${p + 1}` : String(p))).join(" ");
}

/**
 * Check a card from anywhere (AI output, seed data, stored JSON) and return it
 * normalised, or every problem found, each a plain sentence.
 */
export function parseCard(json: unknown): ParseResult {
  if (!isRecord(json)) {
    return { ok: false, problems: ["A card must be an object with a type and a question."] };
  }
  const type = json.type;
  if (!isCardType(type)) {
    const got = type === undefined ? "missing" : JSON.stringify(type);
    return {
      ok: false,
      problems: [`The card type must be one of ${CARD_TYPES.join(", ")}; this one is ${got}.`],
    };
  }

  const problems: string[] = [];
  // Shorthand: a one-blank cloze may give `accept` as a plain list of answers.
  if (type === "cloze" && Array.isArray(json.accept) && typeof json.q === "string") {
    const blanks = clozeBlanks(json.q);
    if (blanks.length === 1) {
      return parseCard({ ...json, accept: { [blanks[0].trim()]: json.accept } });
    } else {
      return {
        ok: false,
        problems: [
          `The accepted answers are a plain list, which only works for a card with one blank; this one has ${blanks.length}. Use { blank answer: [other answers] }.`,
        ],
      };
    }
  }
  const result = CARD_SCHEMAS[type].safeParse(json);
  if (!result.success) {
    for (const issue of result.error.issues) {
      // Our own messages are full sentences; zod's defaults get the field name in front.
      const own = /[.!?]$/.test(issue.message);
      problems.push(own ? issue.message : `${fieldName(issue.path) || "The card"}: ${issue.message}.`);
    }
  }

  // Cross-field shared checks, run on the raw input so they show even when the body is wrong.
  const hasConcept =
    (typeof json.concept === "string" && json.concept.trim() !== "") ||
    (Array.isArray(json.concepts) && json.concepts.length > 0);
  if (!hasConcept) problems.push(`${CARD_NOUN[type]} needs a concept (concept or concepts); this one has none.`);
  const hasSource = json.source !== undefined || json.src !== undefined;
  if (!hasSource) problems.push(`${CARD_NOUN[type]} needs a source, such as "Lecture 5, slide 11"; this one has none.`);

  if (!result.success || problems.length > 0) {
    return { ok: false, problems: Array.from(new Set(problems)) };
  }
  return { ok: true, card: normalise(result.data as ParsedInput) };
}

type ParsedInput = z.infer<typeof SharedFieldsSchema> & Record<string, unknown> & { type: CardType };

function normalise(input: ParsedInput): Card {
  const concepts = Array.from(new Set([...(input.concept ? [input.concept] : []), ...(input.concepts ?? [])]));
  const base: CardBase = {
    concepts,
    boss: input.boss ?? false,
    source: (input.source ?? input.src) as string,
  };
  if (input.core === true) base.core = true;
  if (input.first === true) base.first = true;
  if (input.rung !== undefined) base.rung = input.rung as CardRung;
  if (input.why !== undefined) base.why = input.why;

  switch (input.type) {
    case "basic":
      return { ...base, type: "basic", q: input.q as string, a: input.a as string };
    case "cloze": {
      const accept = normaliseAccept(input.accept as ClozeAccept | undefined);
      return accept ? { ...base, type: "cloze", q: input.q as string, accept } : { ...base, type: "cloze", q: input.q as string };
    }
    case "mcq":
      return { ...base, type: "mcq", q: input.q as string, opts: input.opts as McqOption[] };
    case "match":
      return {
        ...base,
        type: "match",
        q: input.q as string,
        pairs: input.pairs as MatchPair[],
        order: input.order as number[],
      };
    case "explain":
      return {
        ...base,
        type: "explain",
        q: input.q as string,
        rubric: input.rubric as RubricPoint[],
        model: input.model as string,
      };
  }
}

/** Keys trimmed and merged, variants trimmed and de-duplicated, empty lists dropped. */
function normaliseAccept(accept: ClozeAccept | undefined): ClozeAccept | undefined {
  if (!accept) return undefined;
  const out: ClozeAccept = {};
  for (const [key, variants] of Object.entries(accept)) {
    const k = key.trim();
    const merged = Array.from(new Set([...(out[k] ?? []), ...variants.map((v) => v.trim())]));
    if (merged.length > 0) out[k] = merged;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// contentHash
// ---------------------------------------------------------------------------

/**
 * What a card says, for de-duplication. Hashed: `type` and the body
 *   basic: q, a   cloze: q   mcq: q, opts   match: q, pairs   explain: q, rubric, model
 * Not hashed: concepts, rung, boss, core, first, why, source, cloze `accept`, and
 * match `order` (only the display
 * shuffle), so the same card from two sources or tagged differently counts as one.
 * List order inside opts, pairs and rubric does count.
 */
export function contentFields(card: Card): Record<string, unknown> {
  switch (card.type) {
    case "basic":
      return { type: card.type, q: card.q, a: card.a };
    case "cloze":
      return { type: card.type, q: card.q };
    case "mcq":
      return { type: card.type, q: card.q, opts: card.opts };
    case "match":
      return { type: card.type, q: card.q, pairs: card.pairs };
    case "explain":
      return { type: card.type, q: card.q, rubric: card.rubric, model: card.model };
  }
}

/** Strings: Unicode NFC, trimmed, every run of whitespace collapsed to one space. */
function normText(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** JSON with object keys sorted at every level and strings normalised. */
export function canonicalJson(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(normText(value));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const FNV_OFFSET = BigInt("0xcbf29ce484222325");
const FNV_PRIME = BigInt("0x100000001b3");
const MASK_64 = BigInt("0xffffffffffffffff");

/** FNV-1a, 64 bit, over UTF-8 bytes. Pure, so it gives the same answer in Node and the browser. */
function fnv1a64(input: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * A 16-character hex hash of what the card says (see `contentFields`), stable across
 * key order and whitespace. FNV-1a 64 is not cryptographic: it is for spotting
 * duplicate cards in one learner's deck, not for security.
 */
export function contentHash(card: Card): string {
  return fnv1a64(canonicalJson(contentFields(card)));
}

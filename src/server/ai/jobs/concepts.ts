/*
 * Sort a course's lectures into concepts (M3-14): 4 to 10 named concepts for one exam.
 *
 *   const result = await makeConcepts(examId);                       // writes `concepts` rows
 *   await drain(CONCEPTS_KIND, conceptsJob({ tally }), { ... });      // src/app/api/cron/concepts
 *
 * Queued by `queueConcepts` (src/server/study/exams.ts) when an exam is added, by her
 * (`addExam`) or by the Moodle sync (`syncEvents`), and its course has extracted files.
 * Payload `{ examId }`, dedupe key `exam:<examId>`.
 *
 * What is sent. The course's lecture files: files of the exam's course with extracted text
 * (`text_status = 'done'`) that are not attached to an assignment (those are briefs, not
 * lectures). They are put in lecture order and numbered 1..N; that number is the concept's
 * `lecture` (stored as text, "3"), which the screens show as "LECTURE 3". Lecture order is the
 * section name, then the file name, both compared with numeric collation ("Week 2" before
 * "Week 10"). Moodle's own section order is not stored, so a course whose sections are not
 * named in order is sorted by name (cut). For each file the prompt has its number, name,
 * section, page count and the first EXCERPT_MAX (1,500) characters of its text, wrapped with
 * `asData`; `DATA_RULE` is in the system prompt. At most MAX_FILES files are sent, and when
 * many files would go over PROMPT_BUDGET characters each excerpt is shortened evenly (never
 * below EXCERPT_MIN).
 *
 * What comes back. `{ concepts: [{ name, lecture, weight }] }` from the small model through
 * the router's `runObject`, read with a zod schema built for this input: 4 to 10 concepts,
 * `lecture` a whole number 1..N, `weight` a number >= 0. An answer outside that (3 concepts,
 * 30 concepts, a lecture that does not exist) is rejected and the router asks the same
 * provider once to repair it. A second bad answer throws `AiBadOutput`: the job then ends
 * done with no concepts written and nothing cached (`tally.badOutput`). Not failed, and not
 * retried by the queue: a model that gave two bad answers to the same prompt is likely to
 * give more, and each try spends free calls. The next exam added (or a new job for this exam)
 * asks again.
 *
 * Weights. The ticket says weights come from the share of pages. Each lecture's pages are
 * split among the concepts that name that lecture, in proportion to the model's own weights
 * for them (evenly when those are all 0); a concept's weight is the sum of what it got, and
 * the whole set is renormalised to sum to 1. So the model only decides how a lecture is split
 * between its concepts; how much a lecture counts is its page count. Lectures no concept names
 * count for nothing. If page counts are all 0 the model's weights are used, renormalised; if
 * those are 0 too, every concept gets the same weight. Concepts are stored in lecture order
 * (stable for concepts of the same lecture), `position` 0..n-1.
 *
 * Cache. The answer is cached (../cache) under a hash of everything in the prompt (file
 * numbers, names, sections, page counts, excerpts), so the same course material is never
 * asked twice. The cache holds concept names, lecture numbers and model weights, no file text.
 *
 * Privacy. `mayUseFiles(userId, courseId)` (../consent, M2-26/M2-27) is asked first: when it
 * says no (her switch is off, or the course's study rule is not 'allowed'), the job ends done
 * with no AI call and nothing written. Nothing here logs; file text, the prompt and the answer
 * are never logged.
 *
 * Re-running. A run replaces the exam's concepts: the old rows are deleted and the new ones
 * inserted in one transaction, so there are never two sets. Except when she already has study
 * data on them: if any of the exam's concepts is linked from `card_concepts` (cards, and so her
 * reviews, hang off it) or `lecture_concepts` (a lecture page points at it), the concepts are
 * left exactly as they are and nothing is asked (`tally.kept`). Deleting those rows would
 * cascade the links away, and re-sorting under existing cards would orphan them; she cannot
 * rename or reorder concepts yet (cut), so a list in use stays fixed.
 *
 * Errors. `AiBusy` (every free provider limited or down) is thrown, so the queue tries the job
 * again later with its backoff. Nothing is written then.
 */
import { createHash } from "node:crypto";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { iconFor, type ConceptIconName } from "@/components/exams/concept-icons";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courseFiles, filePages } from "@/server/db/schema/courses";
import { lectureConcepts } from "@/server/db/schema/learn";
import { cardConcepts, concepts, exams } from "@/server/db/schema/study";
import { pagesFor } from "@/server/files/search";
import type { JobHandler } from "@/server/jobs/queue";
import { CONCEPTS_KIND } from "@/server/study/exams";
import { asData, DATA_RULE } from "../as-data";
import { cached } from "../cache";
import { mayUseFiles } from "../consent";
import { AiBadOutput, runObject as defaultRunObject, type RunInput, type RunObjectResult } from "../router";

/** The job kind; the tick calls /api/cron/concepts when one is due. Defined next to `queueConcepts`. */
export { CONCEPTS_KIND };
/** Stored in `ai_calls.job` and used as the cache job name. */
export const CONCEPTS_AI_JOB = "sort-concepts";

export const MIN_CONCEPTS = 4;
export const MAX_CONCEPTS = 10;
/** Characters of each file's text sent at most. */
export const EXCERPT_MAX = 1_500;
/** Excerpts are never shortened below this. */
export const EXCERPT_MIN = 200;
/** Characters of excerpts in one prompt, all files together. */
export const PROMPT_BUDGET = 30_000;
/** Files sent at most; later ones in lecture order are left out. */
export const MAX_FILES = 60;
/** Concept names are cut to this many characters. */
export const NAME_MAX = 80;
/** Pages read per file to build its excerpt. */
const EXCERPT_PAGES = 10;

const SYSTEM = [
  "You sort a university course's lectures into the concepts a student must know for the exam.",
  `Read the lecture files below. Give ${MIN_CONCEPTS} to ${MAX_CONCEPTS} concepts in lecture order. ` +
    "Each concept has a short name (2 to 5 words, in the language of the material), `lecture`: the number " +
    "of the file it is mostly taught in, and `weight`: how much of that lecture it covers, from 0 to 1.",
  DATA_RULE,
].join("\n\n");

/** One lecture file as the job sees it. `n` is its number in lecture order, from 1. */
export type LectureFile = { n: number; name: string; section: string | null; pages: number; excerpt: string };

export type ConceptsInput = { files: LectureFile[] };

/** One concept as written: in lecture order, weights summing to 1. */
export type MadeConcept = { name: string; lecture: number; weight: number; icon: ConceptIconName };

type RawConcept = { name: string; lecture: number; weight: number };

export type ConceptsDeps = {
  runObject?: <T>(input: RunInput & { schema: z.ZodType<T> }) => Promise<RunObjectResult<T>>;
  db?: Db;
  userId?: string | null;
};

/** The schema for an input with `fileCount` files: 4..10 concepts, lectures 1..fileCount. */
export function conceptsSchema(fileCount: number) {
  return z.object({
    concepts: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(200),
          lecture: z.number().int().min(1).max(Math.max(1, fileCount)),
          weight: z.number().min(0),
        }),
      )
      .min(MIN_CONCEPTS)
      .max(MAX_CONCEPTS),
  });
}

// ---------------------------------------------------------------------------
// Icons

/**
 * Keyword rules beyond `iconFor`'s, checked first. Each icon is one from the prototype's set
 * (context/tickets/prototype/main-flow.html, CICONS), named as in src/components/exams/concept-icons.
 */
const MORE_ICON_RULES: [RegExp, ConceptIconName][] = [
  [/\bautocorrel|\bcorrelog|\bhistogram|\bdistribution|\bstatistic|\bprobabilit|\bregression/, "chart"],
  [/\bstationar|\bseason|\bcycle|\bsignal|\bwave|\bfrequenc|\boscillat|\bnoise|\barima|\bforecast/, "timeSeries"],
  [/\btrend|\bgrowth|\bderivativ|\bgradient|\bchange\b|\brate\b/, "difference"],
  [/\bpolicy|\bpolicies|\blaw\b|\blegal|\bregulat|\bcomplian|\bethic|\bgdpr|\bprivacy|\brights?\b/, "governance"],
  [/\bchoice|\bchoos|\bstrateg|\bgame theory|\boptimi[sz]/, "decision"],
  [/\bsupply|\bprocure|\boutsourc|\bvendor|\bsupplier|\bexchange|\btransfer|\bpipeline|\bintegrat/, "sourcing"],
  [/\bagreement|\bservice level|\bquality|\brequirement|\baudit|\bstandard/, "contract"],
  [/\bprice|\bpricing|\bcost|\bprofit|\brevenue|\bfinanc|\becon|\bbudget/, "value"],
  [/\bdatabase|\bsql\b|\bstorage|\bwarehouse|\bmetadata|\brecord/, "data"],
];

/** The icon for a concept by keyword, from the prototype's set; the neutral dot when nothing matches. */
export function conceptIcon(name: string): ConceptIconName {
  const lower = name.toLowerCase();
  // iconFor's own rules are the specific ones ("Data governance", "Time series data") and win.
  const base = iconFor(name);
  if (base !== "dot" && base !== "data") return base;
  for (const [pattern, icon] of MORE_ICON_RULES) if (pattern.test(lower)) return icon;
  return base;
}

// ---------------------------------------------------------------------------
// Weights and order

/**
 * Concepts in lecture order with weights from page share, summing to 1. See the file header.
 * `files` gives each lecture's page count by its number.
 */
export function weighConcepts(raw: RawConcept[], files: Pick<LectureFile, "n" | "pages">[]): Omit<MadeConcept, "icon">[] {
  if (raw.length === 0) return [];
  const pagesOf = new Map(files.map((f) => [f.n, Math.max(0, f.pages)]));
  const clean = (w: number) => (Number.isFinite(w) && w > 0 ? w : 0);

  const byLecture = new Map<number, RawConcept[]>();
  for (const c of raw) byLecture.set(c.lecture, [...(byLecture.get(c.lecture) ?? []), c]);

  const share = new Map<RawConcept, number>();
  for (const [lecture, group] of byLecture) {
    const pages = pagesOf.get(lecture) ?? 0;
    const modelTotal = group.reduce((sum, c) => sum + clean(c.weight), 0);
    for (const c of group) share.set(c, modelTotal > 0 ? (pages * clean(c.weight)) / modelTotal : pages / group.length);
  }

  let weights = raw.map((c) => share.get(c) ?? 0);
  if (weights.reduce((a, b) => a + b, 0) <= 0) weights = raw.map((c) => clean(c.weight));
  if (weights.reduce((a, b) => a + b, 0) <= 0) weights = raw.map(() => 1);
  const total = weights.reduce((a, b) => a + b, 0);

  return raw
    .map((c, i) => ({ name: c.name.trim().slice(0, NAME_MAX), lecture: c.lecture, weight: weights[i] / total, i }))
    .sort((a, b) => a.lecture - b.lecture || a.i - b.i)
    .map(({ name, lecture, weight }) => ({ name, lecture, weight }));
}

// ---------------------------------------------------------------------------
// The model call

/** What the cache key is made of: a hash of everything the prompt holds. */
export function conceptsHash({ files }: ConceptsInput): string {
  const parts = files.map((f) => [f.n, f.name, f.section, f.pages, f.excerpt]);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function prompt({ files }: ConceptsInput): string {
  const blocks = files.map((f) =>
    asData(`Lecture ${f.n}: ${f.name}${f.section ? `, section "${f.section}"` : ""}, ${f.pages} pages`, f.excerpt),
  );
  return [`The course has ${files.length} lecture files, numbered in lecture order.`, ...blocks].join("\n\n");
}

/**
 * 4 to 10 concepts for these lecture files, in lecture order, weights summing to 1, each with an
 * icon. Throws `AiBusy` when no free provider can answer and `AiBadOutput` after two bad answers.
 */
export async function sortConcepts(input: ConceptsInput, deps: ConceptsDeps = {}): Promise<MadeConcept[]> {
  const run = deps.runObject ?? defaultRunObject;
  const schema = conceptsSchema(input.files.length);
  const out = await cached(
    CONCEPTS_AI_JOB,
    { hash: conceptsHash(input) },
    async () => {
      const { object } = await run({
        size: "small",
        system: SYSTEM,
        messages: [{ role: "user", content: prompt(input) }],
        job: CONCEPTS_AI_JOB,
        userId: deps.userId ?? null,
        schema,
      });
      return { concepts: object.concepts.map((c) => ({ name: c.name, lecture: c.lecture, weight: c.weight })) };
    },
    { model: "small", database: deps.db ?? defaultDb },
  );
  return weighConcepts(out.concepts, input.files).map((c) => ({ ...c, icon: conceptIcon(c.name) }));
}

// ---------------------------------------------------------------------------
// Reading the course

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** The course's lecture files with extracted text, in lecture order, numbered from 1. */
export async function lectureFiles(userId: string, courseId: string, database: Db = defaultDb): Promise<LectureFile[]> {
  const rows = await database
    .select({ id: courseFiles.id, name: courseFiles.name, section: courseFiles.section })
    .from(courseFiles)
    .where(
      and(
        eq(courseFiles.userId, userId),
        eq(courseFiles.courseId, courseId),
        eq(courseFiles.textStatus, "done"),
        isNull(courseFiles.assignmentId),
      ),
    )
    .orderBy(asc(courseFiles.id));
  if (rows.length === 0) return [];

  rows.sort((a, b) => collator.compare(a.section ?? "", b.section ?? "") || collator.compare(a.name, b.name));
  const chosen = rows.slice(0, MAX_FILES);

  const counts = await database
    .select({ fileId: filePages.fileId, pages: count() })
    .from(filePages)
    .where(inArray(filePages.fileId, chosen.map((r) => r.id)))
    .groupBy(filePages.fileId);
  const pagesOf = new Map(counts.map((c) => [c.fileId, Number(c.pages)]));

  const perFile = Math.max(EXCERPT_MIN, Math.min(EXCERPT_MAX, Math.floor(PROMPT_BUDGET / chosen.length)));
  const out: LectureFile[] = [];
  for (const [i, row] of chosen.entries()) {
    const pages = await pagesFor(userId, row.id, { to: EXCERPT_PAGES, db: database });
    const excerpt = pages
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, perFile);
    out.push({ n: i + 1, name: row.name, section: row.section, pages: pagesOf.get(row.id) ?? 0, excerpt });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The job

export type MakeConceptsResult =
  /** Concepts were written. */
  | { status: "made"; concepts: MadeConcept[] }
  /** Nothing asked, nothing written: no such exam, AI not allowed on its files, or no lecture files. */
  | { status: "skipped" }
  /** Nothing asked, nothing changed: her cards or lecture pages already use this exam's concepts. */
  | { status: "kept" }
  /** The model gave two answers outside 4..10 (or otherwise invalid); nothing written. */
  | { status: "badOutput" };

/** True when any of the exam's concepts has cards or a lecture page linked to it. */
async function inUse(examId: string, database: Db): Promise<boolean> {
  const ids = (await database.select({ id: concepts.id }).from(concepts).where(eq(concepts.examId, examId))).map(
    (r) => r.id,
  );
  if (ids.length === 0) return false;
  const [card] = await database
    .select({ id: cardConcepts.id })
    .from(cardConcepts)
    .where(inArray(cardConcepts.conceptId, ids))
    .limit(1);
  if (card) return true;
  const [page] = await database
    .select({ id: lectureConcepts.id })
    .from(lectureConcepts)
    .where(inArray(lectureConcepts.conceptId, ids))
    .limit(1);
  return Boolean(page);
}

/** Sorts the exam's course into concepts and writes them, replacing the exam's old ones. See the header. */
export async function makeConcepts(examId: string, deps: ConceptsDeps = {}): Promise<MakeConceptsResult> {
  const database = deps.db ?? defaultDb;
  if (!z.uuid().safeParse(examId).success) return { status: "skipped" };
  const [exam] = await database
    .select({ userId: exams.userId, courseId: exams.courseId })
    .from(exams)
    .where(eq(exams.id, examId))
    .limit(1);
  if (!exam) return { status: "skipped" };
  // Her files go to an outside model only where she and the course allow it (M2-26, terms.md d).
  if (!(await mayUseFiles(exam.userId, exam.courseId, database))) return { status: "skipped" };
  if (await inUse(examId, database)) return { status: "kept" };

  const files = await lectureFiles(exam.userId, exam.courseId, database);
  if (files.length === 0) return { status: "skipped" };

  let made: MadeConcept[];
  try {
    made = await sortConcepts({ files }, { runObject: deps.runObject, db: database, userId: exam.userId });
  } catch (error) {
    if (error instanceof AiBadOutput) return { status: "badOutput" };
    throw error;
  }

  const written = await database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // Checked again inside the write: cards made meanwhile keep their concepts.
    if (await inUse(examId, tx)) return false;
    await tx.delete(concepts).where(eq(concepts.examId, examId));
    await tx.insert(concepts).values(
      made.map((c, position) => ({
        userId: exam.userId,
        examId,
        name: c.name,
        lecture: String(c.lecture),
        position,
        weight: c.weight,
        icon: c.icon,
      })),
    );
    return true;
  });
  return written ? { status: "made", concepts: made } : { status: "kept" };
}

/** What the finished `concepts` jobs of one drain did. */
export type ConceptsTally = { made: number; skipped: number; kept: number; badOutput: number };

export type ConceptsPayload = { examId?: unknown };

/** The handler for one `concepts` job. Safe to run twice for the same exam. */
export function conceptsJob(
  options: { tally?: ConceptsTally; db?: Db; runObject?: ConceptsDeps["runObject"] } = {},
): JobHandler<ConceptsPayload> {
  const tally = options.tally ?? { made: 0, skipped: 0, kept: 0, badOutput: 0 };
  return async (payload) => {
    const examId = typeof payload.examId === "string" ? payload.examId : "";
    const result = await makeConcepts(examId, { db: options.db, runObject: options.runObject });
    tally[result.status] += 1;
  };
}

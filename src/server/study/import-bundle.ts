/**
 * Import a hand-made study bundle into one user's account (tickets M3-51 and M3-53).
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
 *   map?, startNewOn?, documents? }`. Weights are renormalised to sum to 1. `gradeTarget` 1..5
 *   becomes `target_pct` with the M3-13 scale (`targetPctForGrade`) and is kept as given in
 *   `exams.grade_target`. A seed without `exam.at` (no exam date yet) is refused: nothing is imported.
 * - A study-only seed (M3-56): `{ studyOnly: true, courseCode?, concepts?, lectures }`, no exam.
 *   Its course code is `courseCode`, else the course folder's name. Only its lectures and lecture
 *   pages are imported (same matching rules as below); cards and concepts need an exam row
 *   (`cards.exam_id`, `concepts.exam_id` are NOT NULL), so they are counted and left out, and so
 *   are lecture-concept links, a map and `exam/`. The deck files are read only to count their
 *   cards; a deck that cannot be read is a problem line, never a reason to stop. A seed with
 *   `studyOnly: true` and an `exam` is refused.
 * - one deck file per lecture: an array of cards in the M3-49 format (`parseCard`); `concept` /
 *   `concepts` hold slugs from seed.json. An optional `id` is the card's stable id. `core`,
 *   `first` and cloze `accept` are part of the format; `beyondSlides`, `basis`, `quote` and
 *   `fromFigure` are copied into `cards.body` as given. Other unknown fields are dropped.
 * - one page per lecture in the M9-05 shape stored in `lecture_content`.
 * - optional `map.json` (named by `seed.map`): `prerequisites` (slug -> slugs), `threads`,
 *   `studyOrder` (lecture groups, then e.g. "Exam essentials").
 * - optional `exam/`: exam documents. Every Markdown file becomes an `exam_documents` row: slug
 *   from its path under `exam/`, title from its first heading (else the file name), position
 *   from `seed.documents` (a list of file names) and then file-name order. Other files (pdf,
 *   json, text) are validated and counted, not imported.
 * The root may hold `account.json`: `{ courses: { <code>: { aiAllowed, scope } } }` (M3-51), or the
 *   M3-57 shape `{ exams: [...], aiAllowed: [{courseCode, allowed, scope?}], gradeWeights, ... }`
 *   (`AccountSchema`). From `exams[]`, a seed whose exam has no date takes the date of the exam
 *   of the same course and title, and a seed with no exam takes its course's only dated exam.
 *
 * Matching rules (so a second run changes nothing):
 * - Course: one of the user's courses whose `code` equals `courseCode` (trimmed, any case).
 *   Never created: `courses.moodle_id` is NOT NULL, so sync Moodle first. Several matches
 *   (an old and a new instance of a retake) is an error unless `courseId` picks one.
 * - Exam: same course + same title. An existing one keeps its date, kind and target (a
 *   difference is a problem line); its `study_map` (the map's prerequisites, threads and
 *   studyOrder), `start_new_on` and `grade_target` are set to the bundle's when the bundle gives
 *   them and they differ (updated). A value the bundle does not give is left as it is.
 * - Concepts: same exam + same `slug`, else same name with no slug yet (a concept imported
 *   before M3-53 gets its slug filled). An existing concept gets the bundle's name, position,
 *   weight and lecture when they differ (updated).
 * - Concept position: the order in `map.studyOrder` when there is one, else the seed's.
 * - Lectures: same course + same `n`. An existing lecture keeps its title and file.
 * - Page: `source_hash` = sha256 of the page's canonical JSON. Same: skipped. Different: replaced.
 * - Lecture concepts: each concept whose `lecture` is one of the bundle's lectures is linked.
 * - Cards, in this order: (1) a card with the same stable `id` in this exam is the same card.
 *   The id is `cards.import_id`, or `body.importId` for a card imported before M3-53. Nothing
 *   differs -> skipped; anything differs (text, core/first/accept, the extra fields, a missing
 *   `import_id`) -> updated in place: memory (`card_states`) kept, links replaced, and
 *   `body.importId` gone; (2) else the same `content_hash` anywhere in her account (the schema's
 *   unique key) -> skipped; (3) else created with `origin 'manual'`, `import_id`,
 *   `card_concepts` links and a fresh `card_states` row due at max(now, `startNewOn` 00:00
 *   Helsinki). Sessions hold new cards back until that day (`./start-date`).
 * - Exam documents: same exam + same slug. Same title, text and position -> skipped; else
 *   updated. A document no longer in the bundle is left.
 * - AI rules (M2-27, `aiRuleFor`): account.json `aiAllowed` (or a list entry's `allowed`) true -> both allowed; false + scope "assignments" ->
 *   ai_assignments off, ai_study allowed; false otherwise -> off + not_allowed; "unknown"/missing -> untouched.
 *
 * Problems (a card skipped, and why) name the file and the card's position, never its text.
 * `notStored` says what the bundle holds that is stored nowhere; `notes` say how some things were read. Writes are batched;
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
import { cardConcepts, cards, cardStates, concepts, EXAM_KINDS, examDocuments, exams } from "@/server/db/schema/study";
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

/** A seed whose exam has no date yet (`at: null`, often with `atIsPlaceholderTime`). */
export const NO_EXAM_DATE = "exam.at is missing: this bundle has no exam date yet. Get the date first; nothing was imported.";
/** A seed that says `studyOnly: true` and still has an exam. */
export const STUDY_ONLY_WITH_EXAM = "studyOnly is true but the seed has an exam; remove one of them. Nothing was imported.";
/** A study-only seed in a one-course root with no `courseCode`. */
export const STUDY_ONLY_NO_CODE = "a study-only seed needs courseCode (or a course folder named by its code); nothing was imported.";

const LectureListSchema = z.array(
  z.object({
    n: z.number().int().min(1, { error: "Each lecture number n must be 1 or more." }),
    title: nonEmpty("Each lecture title"),
    file: z.string().optional(),
    deck: fileName("A lecture's deck").optional(),
    page: fileName("A lecture's page").optional(),
  }),
);
type SeedLecture = z.infer<typeof LectureListSchema>[number];

const dupValues = (list: (string | number)[]) => [...new Set(list.filter((v, i) => list.indexOf(v) !== i))];

export const SeedSchema = z
  .object({
    exam: z.object({
      courseCode: nonEmpty("exam.courseCode"),
      title: nonEmpty("exam.title"),
      kind: z.enum(EXAM_KINDS, { error: `exam.kind must be one of ${EXAM_KINDS.join(", ")}.` }),
      at: z
        .string({
          error: (iss) =>
            iss.input === undefined || iss.input === null ? NO_EXAM_DATE : "exam.at must be an ISO date and time.",
        })
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
    /** Markdown files of `exam/` in the order to show them (with or without the `exam/` prefix). */
    documents: z.array(fileName("Each document")).optional(),
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
    lectures: LectureListSchema,
  })
  .superRefine((seed, ctx) => {
    const dup = dupValues;
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

/**
 * A study-only seed: lectures and pages, no exam. Concepts may be listed (they are counted, not
 * imported); other keys are allowed and ignored.
 */
export const StudySeedSchema = z
  .looseObject({
    studyOnly: z.literal(true),
    courseCode: nonEmpty("courseCode").optional(),
    concepts: z.array(z.unknown(), { error: "concepts must be a list." }).default([]),
    lectures: LectureListSchema,
  })
  .superRefine((seed, ctx) => {
    for (const n of dupValues(seed.lectures.map((l) => l.n))) ctx.addIssue(`Lecture ${n} is listed twice.`);
  });
export type StudySeed = z.infer<typeof StudySeedSchema>;

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
const StudyGroup = z.looseObject({
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

const aiAllowedValue = z
  .union([z.boolean(), z.literal("unknown")], { error: 'aiAllowed must be true, false or "unknown".' })
  .optional();

/**
 * One exam of the bundles-level account.json (M3-57): `{courseCode, title, kind, at,
 * atIsPlaceholderTime, source}`. `at` may be null (no date yet). Other keys are ignored.
 */
export const AccountExamSchema = z.looseObject({
  courseCode: nonEmpty("courseCode"),
  title: nonEmpty("title"),
  kind: z.string().optional(),
  at: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), { error: "at must be an ISO date and time, or null." })
    .nullish(),
  atIsPlaceholderTime: z.boolean().optional(),
});
export type AccountExam = z.infer<typeof AccountExamSchema>;

/**
 * account.json at the bundle root, in either shape:
 * - M3-51: `{ courses: { <code>: { aiAllowed, scope } } }`;
 * - M3-57: `{ exams: [...], gradeWeights: [...], aiAllowed: [{ courseCode, allowed, scope? }], unknown, noExam }`.
 *   The importer reads `aiAllowed[]` (mapped like the old shape; `aiAllowed` is taken as a
 *   synonym of `allowed`) and `exams[]` (to fill a seed's missing exam, see `loadBundle`).
 *   `gradeWeights`, `unknown` and `noExam` are for `seed-account.ts`; other keys are ignored.
 * When both shapes name a course, the list wins.
 */
export const AccountSchema = z
  .object({
    courses: z
      .record(
        z.string(),
        z.looseObject({
          aiAllowed: aiAllowedValue,
          scope: z.string().optional(),
        }),
      )
      .default({}),
    aiAllowed: z
      .array(
        z.looseObject({
          courseCode: nonEmpty("courseCode"),
          allowed: aiAllowedValue,
          aiAllowed: aiAllowedValue,
          scope: z.string().optional(),
        }),
        { error: "aiAllowed must be a list of {courseCode, allowed}." },
      )
      .optional(),
    exams: z.array(AccountExamSchema, { error: "exams must be a list." }).default([]),
  })
  .transform(({ courses: byCode, aiAllowed, exams: examList }) => {
    const merged: Record<string, { aiAllowed?: boolean | "unknown"; scope?: string; [k: string]: unknown }> = { ...byCode };
    for (const entry of aiAllowed ?? []) {
      const { courseCode, allowed, aiAllowed: alias, ...rest } = entry;
      const key = Object.keys(merged).find((k) => normCode(k) === normCode(courseCode)) ?? courseCode;
      merged[key] = { ...rest, aiAllowed: allowed ?? alias };
    }
    return { courses: merged, exams: examList };
  });
export type Account = z.output<typeof AccountSchema>;

// ---------------------------------------------------------------------------
// loadBundle: read and validate the files (no database)
// ---------------------------------------------------------------------------

export type BundleDeck = { lecture: number; file: string; cards: unknown[] };
export type BundlePage = { lecture: number; file: string; page: Page };
/** `text` is set for a Markdown file: its content, to be stored in `exam_documents`. */
export type ExamDoc = { file: string; kind: "pdf" | "json" | "text"; bytes: number; text?: string };

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
  account: { aiAllowed?: boolean | "unknown"; scope?: string; other: string[] } | null;
  /** Set when the seed's exam (or its date) came from account.json's `exams[]` (M3-57). */
  examNote?: string | null;
};

/** One study-only course of a bundle (M3-56): lectures and pages are imported, nothing else. */
export type StudyOnlyCourse = {
  dir: string;
  /** From `courseCode`, else the course folder's name. */
  courseCode: string;
  seed: StudySeed;
  pages: BundlePage[];
  /** Every deck file that could be read, with how many cards it holds (none is imported). */
  decks: { lecture: number; file: string; cards: number }[];
  /** Deck files that could not be read: reported, never a reason to stop. */
  deckProblems: { file: string; lecture: number; reason: string }[];
  /** Files under `exam/` (none is imported: exam documents need an exam). */
  examFiles: number;
  /** `seed.map`, when it names one (not imported). */
  map: string | null;
  account: CourseBundle["account"];
};

/** `courses` hold an exam; `studyOnly` courses hold lectures and pages only. */
export type Bundle = { root: string; courses: CourseBundle[]; studyOnly: StudyOnlyCourse[] };

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
      else examDocs.push({ file, kind: "text", bytes: bytes.length, ...(ext === ".md" ? { text } : {}) });
    } else {
      examDocProblems.push({ file, reason: `has a type the importer does not know (${ext || "no extension"}).` });
    }
  }
  return { examDocs, examDocProblems };
}

/** Reads and validates the lecture pages; a page that is missing or wrong is a bundle problem. */
async function loadPages(dir: string, lectureList: SeedLecture[], at: (f: string) => string, problems: string[]): Promise<BundlePage[]> {
  const pages: BundlePage[] = [];
  for (const lecture of lectureList) {
    if (!lecture.page) continue;
    const raw = await readJson(dir, lecture.page, problems, at(lecture.page));
    if (raw === undefined) continue;
    const page = PageSchema.safeParse(raw);
    if (page.success) pages.push({ lecture: lecture.n, file: lecture.page, page: page.data });
    else problems.push(...issues(at(lecture.page), page.error));
  }
  return pages;
}

/** account.json's entry for a course, by code (trimmed, any case). */
function accountFor(account: Account | null, courseCode: string): CourseBundle["account"] {
  const entry = account ? Object.entries(account.courses).find(([code]) => normCode(code) === normCode(courseCode))?.[1] : undefined;
  return entry
    ? { aiAllowed: entry.aiAllowed, scope: entry.scope, other: Object.keys(entry).filter((k) => k !== "aiAllowed" && k !== "scope") }
    : null;
}

async function loadCourse(dir: string, label: string, seed: Seed, account: Account | null, problems: string[]): Promise<CourseBundle> {
  const at = (f: string) => (label ? `${label}/${f}` : f);
  const decks: BundleDeck[] = [];
  for (const lecture of seed.lectures) {
    if (lecture.deck) {
      const raw = await readJson(dir, lecture.deck, problems, at(lecture.deck));
      if (raw !== undefined) {
        const deck = DeckFileSchema.safeParse(raw);
        if (deck.success) decks.push({ lecture: lecture.n, file: lecture.deck, cards: deck.data });
        else problems.push(...issues(at(lecture.deck), deck.error));
      }
    }
  }
  const pages = await loadPages(dir, seed.lectures, at, problems);

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

  return { dir, seed, map, decks, pages, ...(await loadExamDocs(dir)), account: accountFor(account, seed.exam.courseCode) };
}

async function loadStudyOnly(
  dir: string,
  label: string,
  courseCode: string,
  seed: StudySeed,
  account: Account | null,
  problems: string[],
): Promise<StudyOnlyCourse> {
  const at = (f: string) => (label ? `${label}/${f}` : f);
  // Decks are only counted: a deck that cannot be read is reported, and the pages still go in.
  const decks: StudyOnlyCourse["decks"] = [];
  const deckProblems: StudyOnlyCourse["deckProblems"] = [];
  for (const lecture of seed.lectures) {
    if (!lecture.deck) continue;
    const local: string[] = [];
    const raw = await readJson(dir, lecture.deck, local, lecture.deck);
    if (raw === undefined) {
      deckProblems.push({ file: lecture.deck, lecture: lecture.n, reason: local.join(" ").replace(`${lecture.deck}: `, "") });
      continue;
    }
    const deck = DeckFileSchema.safeParse(raw);
    if (deck.success) decks.push({ lecture: lecture.n, file: lecture.deck, cards: deck.data.length });
    else deckProblems.push({ file: lecture.deck, lecture: lecture.n, reason: "is not a JSON array of cards; its cards were not counted." });
  }
  const pages = await loadPages(dir, seed.lectures, at, problems);
  const examDir = path.join(dir, "exam");
  const examFiles = (await exists(examDir)) ? (await listFiles(examDir)).length : 0;
  const map = typeof seed.map === "string" ? seed.map : null;
  return { dir, courseCode, seed, pages, decks, deckProblems, examFiles, map, account: accountFor(account, courseCode) };
}

/** An EXAM_KINDS value for account.json's free `kind` ("exam" when it is not one). */
export function examKindOf(kind: string | undefined): (typeof EXAM_KINDS)[number] {
  const k = (kind ?? "").trim().toLowerCase();
  return (EXAM_KINDS as readonly string[]).includes(k) ? (k as (typeof EXAM_KINDS)[number]) : "exam";
}

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * M3-57: exams now live in account.json. A seed whose exam has no date gets the date of the
 * account.json exam of the same course and title; a seed with no exam at all gets the
 * course's account.json exam when there is exactly one with a date. Anything else is left for
 * SeedSchema to refuse as before. Returns the (copied) seed and a note saying what was taken.
 */
function examFromAccount(raw: unknown, code: string, account: Account | null): { raw: unknown; note: string | null } {
  if (!isRecord(raw) || !account || account.exams.length === 0) return { raw, note: null };
  const mine = account.exams.filter((e) => normCode(e.courseCode) === code && typeof e.at === "string");
  const exam = raw.exam;
  if (isRecord(exam)) {
    if (exam.at !== undefined && exam.at !== null) return { raw, note: null };
    const title = typeof exam.title === "string" ? exam.title : "";
    const match = mine.find((e) => sameTitle(e.title, title));
    if (!match) return { raw, note: null };
    return { raw: { ...raw, exam: { ...exam, at: match.at } }, note: "The exam's date is from account.json (the seed has none)." };
  }
  if (exam !== undefined && exam !== null) return { raw, note: null };
  if (mine.length !== 1) return { raw, note: null };
  const e = mine[0];
  return {
    raw: { ...raw, exam: { courseCode: e.courseCode, title: e.title, kind: examKindOf(e.kind), at: e.at } },
    note: "The exam (title, kind, date) is from account.json (the seed has none).",
  };
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

  const found: { dir: string; label: string; seed: Seed; examNote: string | null }[] = [];
  const foundStudy: { dir: string; label: string; code: string; seed: StudySeed }[] = [];
  const codesSeen: string[] = [];
  for (const place of places) {
    const seedLabel = place.label ? `${place.label}/seed.json` : "seed.json";
    const raw = await readJson(place.dir, "seed.json", problems, seedLabel);
    if (raw === undefined) continue;
    // Filter on the code before validating, so a course that is not ready is never checked.
    const loose = (isRecord(raw) ? raw : {}) as { exam?: { courseCode?: unknown }; courseCode?: unknown; studyOnly?: unknown };
    const studyOnly = loose.studyOnly === true;
    // A study-only seed has no exam to carry the code: take a top-level one, else the folder's name.
    // A seed with no exam (M3-57: its exam is in account.json) is found by the same code.
    const looseCode = loose.exam?.courseCode ?? (studyOnly || !isRecord(loose.exam) ? (loose.courseCode ?? place.label) : undefined);
    const code = typeof looseCode === "string" && looseCode.trim() !== "" ? normCode(looseCode) : null;
    if (code) codesSeen.push(code);
    if (wanted && (!code || !wanted.has(code))) continue;
    if (studyOnly) {
      if (loose.exam !== undefined) {
        problems.push(`${seedLabel}: ${STUDY_ONLY_WITH_EXAM}`);
        continue;
      }
      if (!code) {
        problems.push(`${seedLabel}: ${STUDY_ONLY_NO_CODE}`);
        continue;
      }
      const parsedStudy = StudySeedSchema.safeParse(raw);
      if (!parsedStudy.success) problems.push(...issues(seedLabel, parsedStudy.error));
      else foundStudy.push({ ...place, code, seed: parsedStudy.data });
      continue;
    }
    const filled = code ? examFromAccount(raw, code, account) : { raw, note: null };
    const parsed = SeedSchema.safeParse(filled.raw);
    if (!parsed.success) {
      problems.push(...issues(seedLabel, parsed.error));
      continue;
    }
    found.push({ ...place, seed: parsed.data, examNote: filled.note });
  }

  if (wanted) {
    for (const w of wanted) if (!codesSeen.includes(w)) problems.push(`No course ${w} in this bundle (it has ${codesSeen.join(", ") || "none"}).`);
  }
  const dupCodes = codesSeen.filter((c, i) => codesSeen.indexOf(c) !== i && (!wanted || wanted.has(c)));
  for (const c of new Set(dupCodes)) problems.push(`Course ${c} is in the bundle twice.`);
  if (problems.length) throw new BundleInvalid(problems);

  const coursesOut: CourseBundle[] = [];
  for (const f of found) coursesOut.push({ ...(await loadCourse(f.dir, f.label, f.seed, account, problems)), examNote: f.examNote });
  const studyOut: StudyOnlyCourse[] = [];
  for (const f of foundStudy) studyOut.push(await loadStudyOnly(f.dir, f.label, f.code, f.seed, account, problems));
  if (problems.length) throw new BundleInvalid(problems);
  return { root, courses: coursesOut, studyOnly: studyOut };
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
  /** The `EXTRA_CARD_FIELDS` the card carries, as given; they go into `cards.body`. */
  extras: Record<string, unknown>;
};

/** One Markdown file of `exam/`, as it will be stored in `exam_documents`. */
export type PlannedDocument = { file: string; slug: string; title: string; bodyMd: string; position: number };

/** What `exams.study_map` holds: the three parts of map.json, as given. */
export type StoredStudyMap = Pick<StudyMap, "prerequisites" | "threads" | "studyOrder">;

export type ImportPlan = {
  exam: {
    courseCode: string;
    title: string;
    kind: (typeof EXAM_KINDS)[number];
    at: Date;
    targetPct: number;
    /** `exams.study_map`, or null when the bundle has no map. */
    studyMap: StoredStudyMap | null;
    /** `exams.start_new_on` (`YYYY-MM-DD`, a Helsinki day), or null when the bundle gives none. */
    startNewOn: string | null;
    /** `exams.grade_target`, as the seed gave it, or null. */
    gradeTarget: number | null;
  };
  concepts: PlannedConcept[];
  lectures: PlannedLecture[];
  cards: PlannedCard[];
  documents: PlannedDocument[];
  /** New cards are not due before this instant (startNewOn, 00:00 Helsinki), or null. */
  startNewAt: Date | null;
  /** account.json for this course: the AI policy to write, or null to leave it. */
  /** M2-27's two columns to write, or null to leave her own answers alone. */
  aiPolicy: { aiAssignments: "off" | "allowed"; aiStudy: "allowed" | "not_allowed" } | null;
  problems: ImportProblem[];
  /** What the bundle holds that is not stored anywhere. */
  notStored: string[];
  /** How some things were read (all of it stored). */
  notes: string[];
};

/** The page's source hash: sha256 of its canonical JSON (key order and whitespace do not count). */
export function pageHash(page: Page): string {
  return createHash("sha256").update(canonicalJson(page)).digest("hex");
}

/**
 * Card fields the M3-49 format has no place for: `parseCard` drops them, so the importer copies
 * them into `cards.body` as given (M3-53). They are never checked, so they never fail a card.
 * `accept`, `first` and `core` are part of the format since M3-52 and land in the body too.
 * (This list was `UNSTORED_CARD_FIELDS` in M3-51; nothing a card carries is left unstored now
 * except fields nobody named.)
 */
export const EXTRA_CARD_FIELDS = ["beyondSlides", "basis", "quote", "fromFigure"] as const;

/** A document's slug: its path under `exam/` without the extension, lower case, dashes. */
function documentSlug(file: string): string {
  return file
    .replace(/^exam\//, "")
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A document's title: its first Markdown heading, else its file name without the extension. */
function documentTitle(file: string, text: string): string {
  const heading = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(text);
  return heading?.[1].trim() || path.basename(file).replace(/\.md$/i, "");
}

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
  const notStored: string[] = [];
  if (course.examNote) notes.push(course.examNote);

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
    }
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
  const firstPerConcept = new Map<string, number>();
  for (const deck of course.decks) {
    deck.cards.forEach((raw, i) => {
      const where = { file: deck.file, lecture: deck.lecture, index: i + 1 };
      const label = `${deck.file} card ${i + 1}`;
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
      const extras: Record<string, unknown> = {};
      for (const field of EXTRA_CARD_FIELDS) {
        const value = (raw as Record<string, unknown>)[field];
        if (value !== undefined && value !== null) extras[field] = value;
      }
      plannedCards.push({ ...where, card, hash, importId, conceptSlugs: card.concepts, extras });
    });
  }
  const manyFirsts = [...firstPerConcept].filter(([, n]) => n > 1).map(([s]) => s);
  if (manyFirsts.length) notes.push(`More than one "first" card for ${manyFirsts.map((s) => `"${s}"`).join(", ")}.`);

  // Exam target, study start, AI policy, exam documents.
  const { exam } = seed;
  const targetPct = exam.targetPct ?? (exam.gradeTarget ? targetPctForGrade(exam.gradeTarget as TargetGrade) : 80);
  const startDay = seed.startNewOn ?? exam.startNewOn ?? map?.startNewOn ?? null;
  const startNewAt = startDay ? helsinkiToInstant(startDay, "00:00") : null;

  const aiPolicy = aiPolicyFor(course.account, notes, notStored);

  // Exam documents: every Markdown file of exam/ is stored; the rest is counted.
  const markdown = course.examDocs.filter((d) => d.text !== undefined);
  const listed = (seed.documents ?? []).map((f) => (f.startsWith("exam/") ? f : `exam/${f}`));
  for (const f of listed) {
    if (!markdown.some((d) => d.file === f)) problems.push({ file: "seed.json", reason: `documents names ${f}, which is not a Markdown file in exam/.` });
  }
  const rank = (file: string) => (listed.includes(file) ? listed.indexOf(file) : listed.length);
  const documents: PlannedDocument[] = [];
  const slugOwner = new Map<string, string>();
  // `examDocs` is in file-name order and the sort is stable, so unlisted files keep that order.
  for (const d of [...markdown].sort((a, b) => rank(a.file) - rank(b.file))) {
    const slug = documentSlug(d.file);
    const owner = slugOwner.get(slug);
    if (slug === "" || owner) {
      problems.push({ file: d.file, reason: slug === "" ? "has no usable name; skipped." : `has the same name as ${owner}; skipped.` });
      continue;
    }
    slugOwner.set(slug, d.file);
    documents.push({ file: d.file, slug, title: documentTitle(d.file, d.text!), bodyMd: d.text!, position: documents.length + 1 });
  }
  const others = course.examDocs.filter((d) => d.text === undefined);
  if (others.length) {
    const kinds = ["pdf", "json", "text"]
      .map((k) => [k, others.filter((d) => d.kind === k).length] as const)
      .filter(([, n]) => n)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");
    notStored.push(`exam/ holds ${plural(others.length, "valid file")} that is not Markdown (${kinds}), not imported: exam_documents holds Markdown only.`);
  }
  for (const p of course.examDocProblems) problems.push({ file: p.file, reason: p.reason });

  return {
    exam: {
      courseCode: exam.courseCode,
      title: exam.title,
      kind: exam.kind,
      at: new Date(exam.at),
      targetPct,
      studyMap: map ? { prerequisites: map.prerequisites, threads: map.threads, studyOrder: map.studyOrder } : null,
      startNewOn: startDay,
      gradeTarget: exam.gradeTarget ?? null,
    },
    concepts: plannedConcepts,
    lectures: plannedLectures,
    cards: plannedCards,
    documents,
    startNewAt,
    aiPolicy,
    problems,
    notStored,
    notes,
  };
}

/**
 * account.json -> M2-27's columns. Missing or "unknown" leaves both as they are, so her own
 * answer is never overwritten. Importing a bundle does not by itself set ai_study.
 */
function aiPolicyFor(account: CourseBundle["account"], notes: string[], notStored: string[]): ImportPlan["aiPolicy"] {
  if (!account) return null;
  const aiPolicy = aiRuleFor(account.aiAllowed, account.scope, notes);
  if (account.other.length) notStored.push(`account.json fields ${account.other.join(", ")} are not stored.`);
  return aiPolicy;
}

/**
 * One course's AI rule from account.json (either shape) -> M2-27's two columns, or null to
 * leave her own answer alone. Shared with `seed-account.ts` (M3-57).
 */
export function aiRuleFor(aiAllowed: boolean | "unknown" | undefined, scope: string | undefined, notes: string[] = []): ImportPlan["aiPolicy"] {
  if (aiAllowed === true) return { aiAssignments: "allowed", aiStudy: "allowed" };
  // No help with assignments; studying the slides with AI is fine.
  if (aiAllowed === false && scope === "assignments") return { aiAssignments: "off", aiStudy: "allowed" };
  if (aiAllowed === false) {
    // No scope (or one we do not know): the safe reading is no AI at all for this course.
    if (scope !== undefined) notes.push(`account.json AI scope "${scope}" is not known; treated as no AI for this course.`);
    return { aiAssignments: "off", aiStudy: "not_allowed" };
  }
  return null;
}

/** A study-only course's plan: its lectures and pages, and what is left out. */
export type StudyOnlyPlan = {
  courseCode: string;
  lectures: PlannedLecture[];
  /** Every card in the deck files: none is imported (cards need an exam). */
  cardsNotImported: number;
  aiPolicy: ImportPlan["aiPolicy"];
  problems: ImportProblem[];
  notStored: string[];
  notes: string[];
};

export function planStudyOnly(course: StudyOnlyCourse): StudyOnlyPlan {
  const notes: string[] = [];
  const notStored: string[] = [];
  const pageOf = new Map(course.pages.map((p) => [p.lecture, p.page]));
  const plannedLectures: PlannedLecture[] = course.seed.lectures.map((l) => {
    const page = pageOf.get(l.n) ?? null;
    return { n: l.n, title: l.title, page, pageHash: page ? pageHash(page) : null };
  });
  const concepts = course.seed.concepts.length;
  if (concepts) notStored.push(`${plural(concepts, "concept")} not imported (concepts need an exam).`);
  if (course.map) notStored.push(`The map ${course.map} is not imported (a study map belongs to an exam).`);
  if (course.examFiles) notStored.push(`exam/ holds ${plural(course.examFiles, "file")}, not imported (exam documents need an exam).`);
  return {
    courseCode: course.courseCode,
    lectures: plannedLectures,
    cardsNotImported: course.decks.reduce((s, d) => s + d.cards, 0),
    aiPolicy: aiPolicyFor(course.account, notes, notStored),
    problems: course.deckProblems.map((p) => ({ file: p.file, lecture: p.lecture, reason: p.reason })),
    notStored,
    notes,
  };
}

/** The study-only summary line. */
export function studyOnlySummary(pagesImported: number, cardsNotImported: number): string {
  return `Study-only course: ${plural(pagesImported, "lecture page")} imported, ${plural(cardsNotImported, "card")} not imported (cards need an exam)`;
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
  documents: Count;
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
  notStored: string[];
  notes: string[];
};

/** The import could not run (no such course, several courses). Nothing was written. */
export class ImportFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFailed";
  }
}

class DryRunRollback<R> extends Error {
  constructor(readonly result: R) {
    super("dry run: rolled back");
  }
}

/** Runs `work` in one transaction (a savepoint inside one); a dry run rolls it back and still returns. */
async function inTransaction<R>(database: Db, dryRun: boolean, work: (tx: Db) => Promise<R>): Promise<R> {
  try {
    return await database.transaction(async (txRaw) => {
      const result = await work(txRaw as unknown as Db);
      if (dryRun) throw new DryRunRollback(result);
      return result;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result as R;
    throw err;
  }
}

type HerCourse = { id: string; aiAssignments: string; aiStudy: string };

/** Her course with this code: found, never created. */
async function findCourse(tx: Db, userId: string, courseCode: string, courseId?: string): Promise<HerCourse> {
  const hers = await tx
    .select({ id: courses.id, code: courses.code, name: courses.name, hidden: courses.hidden, aiAssignments: courses.aiAssignments, aiStudy: courses.aiStudy })
    .from(courses)
    .where(eq(courses.userId, userId));
  let matches = hers.filter((c) => c.code !== null && normCode(c.code) === normCode(courseCode));
  if (courseId) matches = matches.filter((c) => c.id === courseId);
  if (matches.length === 0) {
    throw new ImportFailed(
      `No course with code ${courseCode}${courseId ? ` and id ${courseId}` : ""} ` +
        "for this user. Sync Moodle first: a course cannot be created by hand (courses.moodle_id is required).",
    );
  }
  if (matches.length > 1) {
    const list = matches.map((c) => `${c.id} (${c.name}${c.hidden ? ", hidden" : ""})`).join("; ");
    throw new ImportFailed(`Several courses have code ${courseCode}: ${list}. Pick one with --course-id <id>.`);
  }
  return matches[0];
}

async function writeAiPolicy(tx: Db, course: HerCourse, rules: ImportPlan["aiPolicy"], count: Count): Promise<void> {
  if (!rules) return;
  if (course.aiAssignments === rules.aiAssignments && course.aiStudy === rules.aiStudy) count.skipped += 1;
  else {
    await tx.update(courses).set(rules).where(eq(courses.id, course.id));
    count.updated += 1;
  }
}

/** Lectures by course + n (an existing one keeps its title), then their pages by source hash. */
async function writeLectures(
  tx: Db,
  userId: string,
  courseId: string,
  planned: PlannedLecture[],
  counts: { lectures: Count; pages: Count },
): Promise<Map<number, string>> {
  const lectureRows = await tx
    .select({ id: lectures.id, n: lectures.n })
    .from(lectures)
    .where(and(eq(lectures.userId, userId), eq(lectures.courseId, courseId)));
  const lectureIdOf = new Map(lectureRows.map((l) => [l.n, l.id]));
  const newLectures = planned.filter((l) => !lectureIdOf.has(l.n));
  counts.lectures.skipped += planned.length - newLectures.length;
  if (newLectures.length) {
    const rows = await tx
      .insert(lectures)
      .values(newLectures.map((l) => ({ userId, courseId, n: l.n, title: l.title.trim() })))
      .returning({ id: lectures.id, n: lectures.n });
    for (const r of rows) lectureIdOf.set(r.n, r.id);
    counts.lectures.created += rows.length;
  }

  const withPage = planned.filter((l) => l.page && l.pageHash);
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
  return lectureIdOf;
}

const zero = (): Count => ({ created: 0, skipped: 0, updated: 0 });
const CHUNK = 200;

function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * The card's own fields (the prototype's CARD_DATA body, with core/first/accept) plus the extra
 * fields it carries; shared fields and the stable id have columns.
 */
function cardBody(p: PlannedCard): Record<string, unknown> {
  const { type: _type, concepts: _concepts, rung: _rung, boss: _boss, why: _why, source: _source, ...body } = p.card;
  void [_type, _concepts, _rung, _boss, _why, _source];
  return { ...p.extras, ...body };
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
    importId: p.importId,
  };
}

/** Columns that can differ while the content hash is the same (so a re-import still updates them). */
function sameCard(row: { type: string; rung: number; boss: boolean; body: unknown; why: string | null; source: string | null; importId: string | null }, p: PlannedCard): boolean {
  const c = cardColumns(p);
  return (
    row.importId === c.importId &&
    row.type === c.type &&
    row.rung === c.rung &&
    row.boss === c.boss &&
    row.why === c.why &&
    row.source === c.source &&
    canonicalJson(row.body) === canonicalJson(c.body)
  );
}

const sameJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

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

  return inTransaction(database, dryRun, async (tx) => {
    const counts: ImportCounts = {
      exam: zero(),
      concepts: zero(),
      lectures: zero(),
      pages: zero(),
      lectureConcepts: zero(),
      cards: zero(),
      documents: zero(),
      aiPolicy: zero(),
    };
    const problems: ImportProblem[] = [...plan.problems];

    const course = await findCourse(tx, userId, plan.exam.courseCode, options.courseId);
    const courseId = course.id;
    await writeAiPolicy(tx, course, plan.aiPolicy, counts.aiPolicy);

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
      // The map, the study start and the grade target follow the bundle; the rest is hers.
      const set: Partial<typeof exams.$inferInsert> = {};
      if (plan.exam.studyMap && !sameJson(existingExam.studyMap, plan.exam.studyMap)) set.studyMap = plan.exam.studyMap;
      if (plan.exam.startNewOn && existingExam.startNewOn !== plan.exam.startNewOn) set.startNewOn = plan.exam.startNewOn;
      if (plan.exam.gradeTarget !== null && !sameJson(existingExam.gradeTarget, plan.exam.gradeTarget)) set.gradeTarget = plan.exam.gradeTarget;
      if (Object.keys(set).length) {
        await tx.update(exams).set(set).where(eq(exams.id, examId));
        counts.exam.updated += 1;
      } else counts.exam.skipped += 1;
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
        .values({
          userId,
          courseId,
          title,
          kind: plan.exam.kind,
          at: plan.exam.at,
          targetPct: plan.exam.targetPct,
          studyMap: plan.exam.studyMap,
          startNewOn: plan.exam.startNewOn,
          gradeTarget: plan.exam.gradeTarget,
        })
        .returning({ id: exams.id });
      examId = row.id;
      counts.exam.created += 1;
    }

    // Concepts: by exam + slug, else by name (a concept from before M3-53 has no slug yet).
    const conceptRows = await tx
      .select({ id: concepts.id, name: concepts.name, slug: concepts.slug, lecture: concepts.lecture, position: concepts.position, weight: concepts.weight })
      .from(concepts)
      .where(and(eq(concepts.userId, userId), eq(concepts.examId, examId)));
    const conceptBySlug = new Map(conceptRows.filter((c) => c.slug !== null).map((c) => [c.slug!, c]));
    const conceptByName = new Map(conceptRows.filter((c) => c.slug === null).map((c) => [c.name.trim(), c]));
    const conceptIdOf = new Map<string, string>();
    const newConcepts: PlannedConcept[] = [];
    for (const c of plan.concepts) {
      const name = c.name.trim();
      const row = conceptBySlug.get(c.slug) ?? conceptByName.get(name);
      if (!row) {
        newConcepts.push(c);
        continue;
      }
      conceptIdOf.set(c.slug, row.id);
      if (row.slug === c.slug && row.name === name && row.position === c.position && sameNumber(row.weight, c.weight) && row.lecture === c.lecture) {
        counts.concepts.skipped += 1;
      } else {
        await tx
          .update(concepts)
          .set({ slug: c.slug, name, position: c.position, weight: c.weight, lecture: c.lecture })
          .where(eq(concepts.id, row.id));
        counts.concepts.updated += 1;
      }
    }
    for (const part of chunks(newConcepts)) {
      const rows = await tx
        .insert(concepts)
        .values(part.map((c) => ({ userId, examId, slug: c.slug, name: c.name.trim(), lecture: c.lecture, position: c.position, weight: c.weight })))
        .returning({ id: concepts.id, slug: concepts.slug });
      for (const r of rows) conceptIdOf.set(r.slug!, r.id);
      counts.concepts.created += rows.length;
    }

    // Lectures and their pages.
    const lectureIdOf = await writeLectures(tx, userId, courseId, plan.lectures, counts);

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

    // Exam documents: by exam + slug.
    const docRows = plan.documents.length
      ? await tx
          .select({ id: examDocuments.id, slug: examDocuments.slug, title: examDocuments.title, bodyMd: examDocuments.bodyMd, position: examDocuments.position })
          .from(examDocuments)
          .where(and(eq(examDocuments.userId, userId), eq(examDocuments.examId, examId)))
      : [];
    const docOf = new Map(docRows.map((d) => [d.slug, d]));
    const newDocs = [];
    for (const d of plan.documents) {
      const values = { slug: d.slug, title: d.title, bodyMd: d.bodyMd, position: d.position };
      const row = docOf.get(d.slug);
      if (!row) newDocs.push({ userId, examId, ...values });
      else if (row.title === d.title && row.bodyMd === d.bodyMd && row.position === d.position) counts.documents.skipped += 1;
      else {
        await tx.update(examDocuments).set(values).where(eq(examDocuments.id, row.id));
        counts.documents.updated += 1;
      }
    }
    if (newDocs.length) {
      await tx.insert(examDocuments).values(newDocs);
      counts.documents.created += newDocs.length;
    }

    // Cards: by stable id in this exam (the column, or body.importId from before M3-53),
    // then by content hash in her account.
    const existing = await tx
      .select({
        id: cards.id,
        examId: cards.examId,
        hash: cards.contentHash,
        importId: cards.importId,
        bodyImportId: sql<string | null>`${cards.body}->>'importId'`,
        type: cards.type,
        rung: cards.rung,
        boss: cards.boss,
        body: cards.body,
        why: cards.why,
        source: cards.source,
      })
      .from(cards)
      .where(eq(cards.userId, userId));
    const byHash = new Map(existing.map((c) => [c.hash, c.id]));
    const byImportId = new Map<string, (typeof existing)[number]>();
    // The column wins over the old body field when both name the same id.
    for (const c of existing) if (c.examId === examId && c.importId === null && c.bodyImportId) byImportId.set(c.bodyImportId, c);
    for (const c of existing) if (c.examId === examId && c.importId !== null) byImportId.set(c.importId, c);

    const toInsert: PlannedCard[] = [];
    const toUpdate: { id: string; p: PlannedCard }[] = [];
    for (const p of plan.cards) {
      const same = p.importId ? byImportId.get(p.importId) : undefined;
      if (same) {
        if (same.hash === p.hash) {
          if (sameCard(same, p)) counts.cards.skipped += 1;
          else toUpdate.push({ id: same.id, p });
        } else if (byHash.has(p.hash)) {
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
      notStored: plan.notStored,
      notes: plan.notes,
    };
    return result;
  });
}

export type StudyOnlyCounts = { lectures: Count; pages: Count; aiPolicy: Count };

export type StudyOnlyResult = {
  studyOnly: true;
  dryRun: boolean;
  courseCode: string;
  courseId: string;
  counts: StudyOnlyCounts;
  cardsNotImported: number;
  /** "Study-only course: N lecture pages imported, M cards not imported (cards need an exam)". */
  summary: string;
  problems: ImportProblem[];
  notStored: string[];
  notes: string[];
};

/**
 * Imports a study-only course: its lectures and pages, matched as for any bundle, and the
 * account.json AI rules. No exam, concept, card or link is written. Same transaction and dry
 * run as `applyImport`.
 */
export async function applyStudyOnly(
  database: Db,
  userId: string,
  plan: StudyOnlyPlan,
  options: { dryRun?: boolean; courseId?: string } = {},
): Promise<StudyOnlyResult> {
  const dryRun = options.dryRun ?? false;
  return inTransaction(database, dryRun, async (tx) => {
    const counts: StudyOnlyCounts = { lectures: zero(), pages: zero(), aiPolicy: zero() };
    const course = await findCourse(tx, userId, plan.courseCode, options.courseId);
    await writeAiPolicy(tx, course, plan.aiPolicy, counts.aiPolicy);
    await writeLectures(tx, userId, course.id, plan.lectures, counts);
    return {
      studyOnly: true,
      dryRun,
      courseCode: plan.courseCode,
      courseId: course.id,
      counts,
      cardsNotImported: plan.cardsNotImported,
      summary: studyOnlySummary(counts.pages.created + counts.pages.updated, plan.cardsNotImported),
      problems: [...plan.problems],
      notStored: plan.notStored,
      notes: plan.notes,
    };
  });
}

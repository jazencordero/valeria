/*
 * Turn a lecture's slides into a page to read (M9-05).
 *
 *   const result = await makeLecturePage(lectureId);                        // writes `lecture_content`
 *   await drain(LECTURE_PAGE_KIND, lecturePageJob({ tally }), { ... });     // src/app/api/cron/lecture-page
 *
 * Queued by `syncLectures` (src/server/sync/lectures.ts), one job per lecture whose file has
 * extracted text (`text_status = 'done'`) and that has no `lecture_content` row yet, in a course
 * whose files may go to an AI model. Payload `{ lectureId }`, dedupe key `lecture:<lectureId>`.
 *
 * What is sent. The text of the lecture file's pages (`file_pages`, through `pagesFor`), one
 * block per slide with its real slide number, all inside one `asData` block; `DATA_RULE` is in
 * the system prompt. The prompt says every sentence must come from the slides and to leave out
 * anything they do not say, and to write in the slides' own language (`languageOf` over the
 * slide text: Finnish, Swedish or English).
 *
 * Budget. At most PROMPT_BUDGET (24,000) characters of slide text go in one prompt. Each slide is
 * cut to its fair share (PROMPT_BUDGET / slides, between SLIDE_MIN and SLIDE_MAX characters);
 * when even SLIDE_MIN per slide would go over (a deck of hundreds of slides), slides are sampled
 * evenly across the deck, first and last always kept, and the prompt says that some slides were
 * left out. Slide numbers stay the real ones, so a section's range still points at the deck. The
 * page itself does not say a deck was sampled (cut: no column for it; the deck needs to be
 * longer than PROMPT_BUDGET / SLIDE_MIN = 300 slides before it happens).
 *
 * Model size. `small` (providers.config) unless the slide text sent is over MEDIUM_FROM (12,000)
 * characters, then `medium`: a long deck needs a model that keeps the order of 3 to 6 sections
 * over a long input, and the small ones lose it first. Both are free models only (the router).
 *
 * What comes back. `{ breath, minutes, sections: [{ heading, blocks, terms, slides }], slideTitles }`
 * through the router's `runObject`, read with a zod schema built for this file: 3 to 6 sections,
 * each block `['p', text]`, `['ul', [items]]` or `['dl', [[term, definition]]]`, and `slides` a
 * range "slides 2–5" (or "slide 3"; hyphen or en dash) whose both ends are pages the file has.
 * A malformed range, or one outside the file, is rejected and the router asks the same provider
 * once to repair it: that is the single retry. A second bad answer throws `AiBadOutput`: the job
 * ends done with nothing written and nothing cached (`tally.badOutput`), as in M3-14. The next
 * sync queues the lecture again, since it still has no content.
 *
 * After reading, sections are put in slide order (by first slide, stable), ranges are rewritten
 * as "slides 2–5" / "slide 3" with an en dash, `slideTitles` is cut to the deck's slide count.
 * `minutes` (reading time) is not the model's number: it is counted from the page's own words at
 * WORDS_PER_MINUTE (200), at least 1, so it always matches what is written.
 *
 * Thin decks. When the file's text is under THIN_CHARS (300) characters in all (picture-only
 * slides, a scanned deck) nothing is asked. A row is still written with `breath` null, no
 * sections and `minutes` null: that is the "thin" mark the lecture screen reads to say plainly
 * that the slides are mostly pictures, and it keeps the sync from queueing the lecture again.
 *
 * Cache. The model's answer is cached (../cache) under the hash of the file's text (`sourceHash`:
 * every page number and text), the language and the model size, so the same file is never sent
 * twice, also not for a second lecture row with the same deck. The hash is stored in
 * `lecture_content.source_hash`; a job for a lecture whose stored hash matches the file's text
 * asks nothing (`tally.kept`). A changed file is written again over the old row.
 *
 * Privacy. `mayUseFiles(userId, courseId)` (../consent, M2-26/M2-27) is asked first: when it says
 * no, the job ends done with no AI call and nothing written. Nothing here logs; slide text, the
 * prompt and the answer are never logged.
 *
 * Errors. `AiBusy` (every free provider limited or down) is thrown, so the queue tries the job
 * again later with its backoff. Nothing is written then.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courseFiles } from "@/server/db/schema/courses";
import { lectureContent, lectures } from "@/server/db/schema/learn";
import { pagesFor, type PageText } from "@/server/files/search";
import type { JobHandler } from "@/server/jobs/queue";
import { LECTURE_PAGE_KIND } from "@/server/sync/lectures";
import { asData, DATA_RULE } from "../as-data";
import { cached } from "../cache";
import { mayUseFiles } from "../consent";
import { LANGUAGE_NAMES, languageOf, type Language } from "../language";
import type { SizeClass } from "../providers.config";
import { AiBadOutput, runObject as defaultRunObject, type RunInput, type RunObjectResult } from "../router";

/** The job kind; the tick calls /api/cron/lecture-page when one is due. Defined next to `syncLectures`. */
export { LECTURE_PAGE_KIND };
/** Stored in `ai_calls.job` and used as the cache job name. */
export const LECTURE_PAGE_AI_JOB = "lecture-page";

export const MIN_SECTIONS = 3;
export const MAX_SECTIONS = 6;
/** Characters of slide text in one prompt, all slides together. */
export const PROMPT_BUDGET = 24_000;
/** A slide is never cut below this; past it, slides are sampled instead. */
export const SLIDE_MIN = 80;
/** A slide is never sent longer than this. */
export const SLIDE_MAX = 2_000;
/** Slide text over this many characters goes to the medium model. */
export const MEDIUM_FROM = 12_000;
/** Under this many characters of text in all, the deck is thin: nothing is asked. */
export const THIN_CHARS = 300;
export const WORDS_PER_MINUTE = 200;

// ---------------------------------------------------------------------------
// The answer

/** A block of a section: a paragraph, a list, or term–definition pairs. */
export type Block = ["p", string] | ["ul", string[]] | ["dl", [string, string][]];

export type PageSection = { heading: string; blocks: Block[]; terms: string[]; slides: string };

/** What is written to `lecture_content`. `breath` null and no sections is a thin deck. */
export type LecturePage = { breath: string | null; minutes: number | null; sections: PageSection[]; slideTitles: string[] };

const SLIDES = /^\s*slides?\s+(\d+)\s*(?:[-–—]\s*(\d+))?\s*$/i;

/** `[first, last]` of a range such as "slides 2–5", "slides 2-5" or "slide 3"; null when malformed. */
export function parseSlides(range: string): [number, number] | null {
  const m = SLIDES.exec(range);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return a <= b ? [a, b] : null;
}

/** "slide 3" or "slides 2–5" (en dash). */
export function formatSlides([a, b]: [number, number]): string {
  return a === b ? `slide ${a}` : `slides ${a}–${b}`;
}

const text = (max: number) => z.string().trim().min(1).max(max);

/** The schema for a file whose pages are `pages`: 3..6 sections, every range inside the file. */
export function lecturePageSchema(pages: readonly number[]) {
  const have = new Set(pages);
  return z.object({
    breath: text(1_500),
    minutes: z.number().optional(),
    sections: z
      .array(
        z.object({
          heading: text(160),
          blocks: z
            .array(
              z.union([
                z.tuple([z.literal("p"), text(3_000)]),
                z.tuple([z.literal("ul"), z.array(text(600)).min(1).max(20)]),
                z.tuple([z.literal("dl"), z.array(z.tuple([text(160), text(600)])).min(1).max(20)]),
              ]),
            )
            .min(1)
            .max(12),
          terms: z.array(text(80)).max(15),
          slides: z.string().refine(
            (range) => {
              const r = parseSlides(range);
              return r !== null && have.has(r[0]) && have.has(r[1]);
            },
            { message: `must be "slides A–B" or "slide A" with slides that exist (1 to ${Math.max(0, ...pages)})` },
          ),
        }),
      )
      .min(MIN_SECTIONS)
      .max(MAX_SECTIONS),
    slideTitles: z.array(z.string().trim().max(200)).max(1_000),
  });
}

type Raw = z.infer<ReturnType<typeof lecturePageSchema>>;

function blockWords(block: Block): string[] {
  if (block[0] === "p") return [block[1]];
  if (block[0] === "ul") return block[1];
  return block[1].flat();
}

/** Reading time of the written page: its words at WORDS_PER_MINUTE, at least 1 minute. */
export function readingMinutes(page: Pick<LecturePage, "breath" | "sections">): number {
  const parts = [page.breath ?? "", ...page.sections.flatMap((s) => [s.heading, ...s.blocks.flatMap(blockWords)])];
  const words = parts.join(" ").match(/\S+/g)?.length ?? 0;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/** Sections in slide order with ranges written one way, titles cut to the deck, minutes counted. */
export function tidyPage(raw: Raw, slideCount: number): LecturePage {
  const sections = raw.sections
    .map((s, i) => ({ s, i, range: parseSlides(s.slides)! }))
    .sort((a, b) => a.range[0] - b.range[0] || a.i - b.i)
    .map(({ s, range }) => ({
      heading: s.heading,
      blocks: s.blocks as Block[],
      terms: s.terms,
      slides: formatSlides(range),
    }));
  const page = { breath: raw.breath, sections, slideTitles: raw.slideTitles.slice(0, slideCount) };
  return { ...page, minutes: readingMinutes(page) };
}

// ---------------------------------------------------------------------------
// The prompt

export type Slides = {
  /** Every page the file has, in order, with its text. */
  pages: PageText[];
};

/** The file's text hash: every page number and text. Stored as `source_hash`; the cache key. */
export function sourceHash(pages: readonly PageText[]): string {
  return createHash("sha256")
    .update(JSON.stringify(pages.map((p) => [p.page, p.text])))
    .digest("hex");
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** All the text the deck has, whitespace collapsed. */
export function deckText(pages: readonly PageText[]): string {
  return pages.map((p) => clean(p.text)).filter(Boolean).join("\n");
}

/** Under THIN_CHARS characters of text: picture-only or scanned slides. */
export function isThin(pages: readonly PageText[]): boolean {
  return deckText(pages).length < THIN_CHARS;
}

/**
 * The slides that fit PROMPT_BUDGET, each cut to its share. `sampled` is true when some slides
 * were left out (evenly across the deck, first and last kept).
 */
export function budgetSlides(pages: readonly PageText[]): { slides: PageText[]; sampled: boolean } {
  const all = pages.map((p) => ({ page: p.page, text: clean(p.text) }));
  if (all.length === 0) return { slides: [], sampled: false };
  const fit = Math.floor(PROMPT_BUDGET / SLIDE_MIN);
  let chosen = all;
  if (all.length > fit) {
    const picks = new Set<number>();
    for (let k = 0; k < fit; k++) picks.add(Math.round((k * (all.length - 1)) / (fit - 1)));
    chosen = all.filter((_, i) => picks.has(i));
  }
  const share = Math.max(SLIDE_MIN, Math.min(SLIDE_MAX, Math.floor(PROMPT_BUDGET / chosen.length)));
  return { slides: chosen.map((p) => ({ page: p.page, text: p.text.slice(0, share) })), sampled: chosen.length < all.length };
}

function system(language: Language): string {
  return [
    "You turn a university lecture's slides into a page a student reads instead of clicking through the deck.",
    "Give: `breath`, one short paragraph that says what the whole lecture is about, as if in one breath; " +
      `${MIN_SECTIONS} to ${MAX_SECTIONS} \`sections\` that follow the slide order, each with a short \`heading\`, ` +
      "`blocks` (each block is [\"p\", paragraph] or [\"ul\", [items]] or [\"dl\", [[term, definition]]]), " +
      "`terms`: the key terms of that section, and `slides`: the slide range it came from, written \"slides 2–5\" " +
      "or \"slide 3\"; and `slideTitles`: each slide's title in slide order.",
    "Every sentence must be supported by the slide text. Leave out anything the slides do not say: no outside " +
      "facts, no examples of your own, no guesses about what the lecturer meant. If the slides say little, write little.",
    `Write the page in ${LANGUAGE_NAMES[language]}, the language of the slides.`,
    DATA_RULE,
  ].join("\n\n");
}

function prompt(slides: PageText[], total: number, sampled: boolean, label: string): string {
  const first = slides[0]?.page ?? 1;
  const last = slides[slides.length - 1]?.page ?? 1;
  const body = slides.map((s) => `[Slide ${s.page}]\n${s.text}`).join("\n\n");
  return [
    `The deck has ${total} slides, numbered ${first} to ${last}. Only cite slides in that range.`,
    sampled ? "It is long, so only some of its slides are below; their numbers are the real ones." : "",
    asData(label, body),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type LecturePageDeps = {
  runObject?: <T>(input: RunInput & { schema: z.ZodType<T> }) => Promise<RunObjectResult<T>>;
  db?: Db;
  userId?: string | null;
};

/**
 * The page for these slides. Throws `AiBusy` when no free provider can answer and `AiBadOutput`
 * after two bad answers. Cached by the file's text hash, language and model size.
 */
export async function writeLecturePage(
  input: { pages: PageText[]; label: string },
  deps: LecturePageDeps = {},
): Promise<LecturePage> {
  const run = deps.runObject ?? defaultRunObject;
  const numbers = input.pages.map((p) => p.page);
  const { slides, sampled } = budgetSlides(input.pages);
  const sent = slides.reduce((sum, s) => sum + s.text.length, 0);
  const size: SizeClass = sent > MEDIUM_FROM ? "medium" : "small";
  const language = languageOf(deckText(input.pages));
  const schema = lecturePageSchema(numbers);

  const raw = await cached(
    LECTURE_PAGE_AI_JOB,
    { hash: sourceHash(input.pages), language, size },
    async () => {
      const { object } = await run({
        size,
        system: system(language),
        messages: [{ role: "user", content: prompt(slides, input.pages.length, sampled, input.label) }],
        job: LECTURE_PAGE_AI_JOB,
        userId: deps.userId ?? null,
        schema,
      });
      return object;
    },
    { model: size, database: deps.db ?? defaultDb },
  );
  // A cached answer was read by the same schema (same pages, so same ranges); read it again anyway.
  return tidyPage(schema.parse(raw), input.pages.length);
}

// ---------------------------------------------------------------------------
// The job

export type MakeLecturePageResult =
  /** A page was written. */
  | { status: "made"; page: LecturePage }
  /** Too little text: nothing asked, a thin row written. */
  | { status: "thin" }
  /** Nothing asked, nothing written: no such lecture, no file with text, or AI not allowed on its files. */
  | { status: "skipped" }
  /** Nothing asked: the stored page is from this exact file text. */
  | { status: "kept" }
  /** Two bad answers (a slide range outside the file, a malformed one, broken JSON); nothing written. */
  | { status: "badOutput" };

async function store(lectureId: string, page: LecturePage, hash: string, database: Db): Promise<void> {
  const values = {
    breath: page.breath,
    minutes: page.minutes,
    sections: page.sections,
    slideTitles: page.slideTitles,
    sourceHash: hash,
  };
  await database
    .insert(lectureContent)
    .values({ lectureId, ...values })
    .onConflictDoUpdate({ target: lectureContent.lectureId, set: values });
}

/** Writes the lecture's page from its file's slides. See the header. */
export async function makeLecturePage(lectureId: string, deps: LecturePageDeps = {}): Promise<MakeLecturePageResult> {
  const database = deps.db ?? defaultDb;
  if (!z.uuid().safeParse(lectureId).success) return { status: "skipped" };
  const [lecture] = await database
    .select({
      userId: lectures.userId,
      courseId: lectures.courseId,
      title: lectures.title,
      n: lectures.n,
      fileId: courseFiles.id,
      textStatus: courseFiles.textStatus,
    })
    .from(lectures)
    .innerJoin(courseFiles, and(eq(courseFiles.id, lectures.fileId), eq(courseFiles.userId, lectures.userId)))
    .where(eq(lectures.id, lectureId))
    .limit(1);
  if (!lecture || lecture.textStatus !== "done") return { status: "skipped" };
  // Her files go to an outside model only where she and the course allow it (M2-26, terms.md d).
  if (!(await mayUseFiles(lecture.userId, lecture.courseId, database))) return { status: "skipped" };

  const pages = await pagesFor(lecture.userId, lecture.fileId, { db: database });
  if (pages.length === 0) return { status: "skipped" };
  const hash = sourceHash(pages);

  const [had] = await database
    .select({ sourceHash: lectureContent.sourceHash })
    .from(lectureContent)
    .where(eq(lectureContent.lectureId, lectureId))
    .limit(1);
  if (had?.sourceHash === hash) return { status: "kept" };

  if (isThin(pages)) {
    await store(lectureId, { breath: null, minutes: null, sections: [], slideTitles: [] }, hash, database);
    return { status: "thin" };
  }

  let page: LecturePage;
  try {
    page = await writeLecturePage(
      { pages, label: `Lecture ${lecture.n}: ${lecture.title}` },
      { runObject: deps.runObject, db: database, userId: lecture.userId },
    );
  } catch (error) {
    if (error instanceof AiBadOutput) return { status: "badOutput" };
    throw error;
  }
  await store(lectureId, page, hash, database);
  return { status: "made", page };
}

/** What the finished `lecture-page` jobs of one drain did. */
export type LecturePageTally = { made: number; thin: number; skipped: number; kept: number; badOutput: number };

export type LecturePagePayload = { lectureId?: unknown };

/** The handler for one `lecture-page` job. Safe to run twice for the same lecture. */
export function lecturePageJob(
  options: { tally?: LecturePageTally; db?: Db; runObject?: LecturePageDeps["runObject"] } = {},
): JobHandler<LecturePagePayload> {
  const tally = options.tally ?? { made: 0, thin: 0, skipped: 0, kept: 0, badOutput: 0 };
  return async (payload) => {
    const lectureId = typeof payload.lectureId === "string" ? payload.lectureId : "";
    const result = await makeLecturePage(lectureId, { db: options.db, runObject: options.runObject });
    tally[result.status] += 1;
  };
}

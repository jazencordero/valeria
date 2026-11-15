/*
 * M2-28: what the tutor knows, built on the server for every message.
 *
 *   const context = await buildTutorContext(userId, where, { firstAnswer: history.length === 0 });
 *   ai.streamChat({ systemParts: context.parts, messages, job: "tutor", paid: "tutor", ... });
 *
 *   const copy = await buildCopyPrompt(userId, where, question);   // "Copy for Claude"
 *
 * Where she is comes from the client (`TutorWhere`, read from the address bar and, in a study
 * session, from the card on screen). Every id is checked against her own rows; anything that is
 * not hers, or gone, reads as "anywhere else" and loads nothing of it.
 *
 *   lecture     that lecture's ONE section she is on (index from the client, clamped), with its
 *               key points, worked example and terms, cut to SECTION_MAX_CHARS, and the concept
 *               names of the lecture. Not the whole page. With a highlighted passage (`quote`):
 *               the passage first, then the section it sits in, then the concept names.
 *   exam        the exam's concepts and the three she is weakest at (mastery on exam day, as the
 *               exam page computes it).
 *   study       the card on screen, but only when the client says she has answered or revealed
 *               it (`revealed: true`); before that nothing of the card is sent, not even its
 *               question (a cloze question holds its own answer).
 *   assignment  the assignment's name and due time only (never the brief: the assignment chat is
 *               where briefs go), and nothing at all when the course's assignment help is off.
 *   other       her courses and what is due in the next 14 days.
 *
 * Hard rules, in code and not only in the prompt:
 * - Course text (lecture text, card text) is put in only when `mayUseFiles(userId, courseId)`
 *   (her switch AND the course's study rule `allowed`, M2-26/M2-27). Otherwise the prompt says
 *   she has no material here and to say so once.
 * - A course whose assignment help is `off` (or not answered yet, which counts as off) puts no
 *   assignment row of it in the context, and the prompt names the course and says not to
 *   discuss its assignments at all.
 * - Everything that came from her school (names, titles, text) is wrapped with `asData`, and
 *   `DATA_RULE` is in the prompt.
 * - It never writes assignment answers or hand-in text (rule), and it can change nothing.
 * - A highlighted passage counts as course text only when it really is a piece of her own
 *   lecture's stored content (whitespace and case aside). Then it follows the course text rule
 *   above (left out entirely where study is not allowed). Anything else she quotes is treated
 *   as her own words: wrapped as data, labelled as hers, never as course material.
 *
 * Each place also names the chat it belongs to when there is no note (`anchor`): the lecture,
 * the exam, the card on screen (by id, before or after she answers it), or "general".
 *
 * Size: the free providers are tight (Groq's free plan: 8K tokens a minute, input plus output),
 * so the context stays small: the rules (~500 tokens), one section (SECTION_MAX_CHARS, ~900
 * tokens), the place (a few lines). The route adds at most HISTORY_MAX_CHARS of history and caps
 * the answer at ANSWER_MAX_TOKENS.
 *
 * Order, for Anthropic's prompt cache: the fixed rules first, then the course text (passage,
 * section, concepts) with the cache breakpoint, then what changes from message to message (the
 * place, the "say it once" line). Follow-ups about the same passage share the cached prefix.
 * The free providers get the same parts joined.
 *
 * No AI SDK and no router in here (tests/arch/ai-boundary.test.ts).
 */
import { and, asc, eq, gte, inArray, isNull, lte, not } from "drizzle-orm";
import { z } from "zod";
import { assignmentHelp, type AiAssignments, type AiStudy } from "@/lib/ai-policy";
// dateLine, not listDate: the tutor is told the month too ("MON 23 NOV · 09:00"), it has no calendar.
import { dateLine } from "@/lib/dates";
import { conceptMastery } from "@/lib/study/ladder";
import { newCard } from "@/lib/study/memory";
import { asData, DATA_RULE } from "@/server/ai/as-data";
import { mayUseFiles } from "@/server/ai/consent";
import { sectionsOf } from "@/server/data/lecture";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { lectureConcepts, lectureContent, lectures, TUTOR_ANCHOR_KINDS } from "@/server/db/schema/learn";
import { cards, concepts, exams, studySessions } from "@/server/db/schema/study";
import { assignments } from "@/server/db/schema/work";
import { loadDeck } from "@/server/study/store";
import type { LectureBlock, LectureSection } from "@/components/lecture/reader";

/** The line every busy path shows, word for word (the drawer keeps its own copy, tested equal). */
export const TUTOR_RESTING = "The tutor is resting. Try again in a minute.";

export const MESSAGE_MAX_CHARS = 4000;
/** History sent with each question: the last 8 stored messages of the chat. */
export const HISTORY_MESSAGES = 8;
/** History (her messages and the answers before this one) the free models can afford. */
export const HISTORY_MAX_CHARS = 6000;
/** The free providers' answer cap. The Claude path has its own (src/server/tutor/budget.ts). */
export const ANSWER_MAX_TOKENS = 1500;
export const SECTION_MAX_CHARS = 3500;
/** A highlighted passage as sent to the model. */
export const QUOTE_MAX_CHARS = 1500;
/** Shorter than this (after tidying spaces) is never matched as course text. */
const QUOTE_MIN_CHARS = 3;
const CONCEPTS_MAX = 20;
const DUE_DAYS = 14;
const DUE_MAX = 8;
const WEAKEST = 3;

/** Is the tutor switched on for this account (`users.settings.tutor.enabled === true`)? */
export function tutorEnabled(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const tutor = (settings as Record<string, unknown>).tutor;
  if (typeof tutor !== "object" || tutor === null) return false;
  return (tutor as Record<string, unknown>).enabled === true;
}

export const whereSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("lecture"),
    courseId: z.uuid(),
    n: z.number().int().min(1).max(999_999),
    section: z.number().int().min(0).max(999).optional(),
  }),
  z.object({ kind: z.literal("exam"), examId: z.uuid() }),
  z.object({
    kind: z.literal("study"),
    sessionId: z.uuid(),
    cardId: z.uuid().optional(),
    revealed: z.boolean(),
  }),
  z.object({ kind: z.literal("assignment"), assignmentId: z.uuid() }),
  z.object({ kind: z.literal("other") }),
]);

export type TutorWhere = z.infer<typeof whereSchema>;

export type SystemPart = { text: string; cache?: boolean };

export type TutorAnchorKind = (typeof TUTOR_ANCHOR_KINDS)[number];
/** What a chat without a note belongs to. `id` is null for "general". */
export type TutorAnchor = { kind: TutorAnchorKind; id: string | null };
const GENERAL: TutorAnchor = { kind: "general", id: null };

export type TutorContext = {
  parts: SystemPart[];
  /** True when course text (lecture or card text) is in the prompt. */
  courseText: boolean;
  /** The course she is in, when the place has one and it is hers. */
  courseId: string | null;
  /** The chat this place belongs to when there is no note. */
  anchor: TutorAnchor;
  /**
   * The passage she sent, and what became of it: `course` when it is a piece of her lecture,
   * `sent` when it went into the prompt (as course text, or as her own words).
   */
  quote: { text: string; course: boolean; sent: boolean } | null;
};

// ---------------------------------------------------------------------------
// The rules

const RULES = [
  "You are Ready's tutor. She is a university student preparing for her exams, and she asks you to explain things.",
  "How to explain:",
  "- Start from zero: assume she has never seen the idea. Say what it is in one or two plain sentences first.",
  "- Then show one small worked example with real, small numbers, step by step.",
  "- One idea at a time. Keep it short: a few short paragraphs. If there is more, offer to go on.",
  "- When she seems unsure or says she does not get it, end with one short check question she can answer in a line. Otherwise do not quiz her.",
  "- When something is not in her course material below, say so plainly before you answer from general knowledge.",
  "- Answer in the language she writes in.",
  "- Plain text only: no Markdown headings, no tables, no LaTeX. Write formulas in plain characters, for example a^2 + b^2 = c^2, x = (-b ± √(b^2 - 4ac)) / (2a), or E[X] = Σ x·p(x).",
  "Hard rules:",
  "- Never write an answer to an assignment, or any text she could hand in (essays, reports, code, solutions to set exercises). If she asks for one, say you cannot write work she hands in, and offer to explain the idea behind it instead.",
  "- You cannot change anything in her account, her courses or her school's course platform, and you cannot see her screen beyond what is written below.",
].join("\n");

const NO_MATERIAL_FIRST =
  "You do not have her course material here: either the course does not allow AI for studying, or her switch for course files is off. " +
  "Answer from general knowledge, and say once, at the start of this answer, that you are not using her course material.";
const NO_MATERIAL_AGAIN =
  "You do not have her course material here. You already told her so; do not say it again. Answer from general knowledge.";

const PASSAGE_RULE = [
  "She highlighted the passage above in her lecture and is asking about it. For this answer:",
  "- Answer her question about that passage, in plain words.",
  "- Give one small worked example with real, small numbers.",
  "- End with one short check question she can answer in a line.",
  "- If the passage and its section do not contain the answer, say so plainly first, then answer from general knowledge.",
].join("\n");

const HER_WORDS_RULE =
  "She quoted the text above. It is not from her course material as far as Ready can tell, so treat it as her own words: explain it, but do not call it her course material.";

function offCoursesRule(names: string[]): string {
  return [
    "These courses do not allow AI help on their assignments. Do not discuss their assignments at all, not even to explain what one asks or to give hints for it. " +
      "If she asks about one, say that the course does not allow AI help on its assignments and that her teacher is the one to ask. You may still explain the course's topics for her exams.",
    asData("Courses with no AI help on assignments", names.join("\n")),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Text helpers

function blockText(b: LectureBlock): string {
  if (b.kind === "p") return b.text;
  if (b.kind === "ul") return b.items.map((i) => `- ${i}`).join("\n");
  return b.items.map((i) => `${i.term}: ${i.def}`).join("\n");
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One section as plain text: heading, key points, text, worked example, terms. Cut to `max`. */
export function sectionText(s: LectureSection, max = SECTION_MAX_CHARS): string {
  const lines = [s.heading];
  if (s.keyPoints?.length) lines.push("Key points:", ...s.keyPoints.map((k) => `- ${k}`));
  lines.push(...s.blocks.map(blockText));
  if (s.example) {
    lines.push(`Worked example: ${s.example.title}`, ...s.example.steps.map((step, i) => `${i + 1}. ${step}`));
    if (s.example.result) lines.push(`Result: ${s.example.result}`);
  }
  if (s.terms?.length) lines.push(`Key terms: ${s.terms.join(", ")}`);
  return cut(lines.filter(Boolean).join("\n"), max);
}

/** Spaces tidied and case folded, so a passage copied from the page matches what is stored. */
function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Every piece of text a section shows on the page, tidied, for matching a passage. */
function searchText(s: LectureSection): string {
  const out: string[] = [s.heading];
  const blocks = (list: LectureBlock[] | undefined) => {
    for (const b of list ?? []) {
      if (b.kind === "p") out.push(b.text);
      else if (b.kind === "ul") out.push(...b.items);
      else for (const i of b.items) out.push(i.term, i.def);
    }
  };
  out.push(...(s.keyPoints ?? []));
  blocks(s.blocks);
  blocks(s.fromScratch);
  if (s.example) out.push(s.example.title, ...s.example.steps, s.example.result);
  for (const x of s.stuck ?? []) out.push(x.q, x.a);
  out.push(...(s.terms ?? []));
  return tidy(out.join(" "));
}

/**
 * Where `quote` sits in her lecture: the index of the section that contains it, `-1` when it is
 * in the lecture but spans sections, or null when it is not her lecture's text at all.
 */
export function findPassage(sections: LectureSection[], quote: string): number | null {
  const q = tidy(quote);
  if (q.length < QUOTE_MIN_CHARS) return null;
  const texts = sections.map(searchText);
  const at = texts.findIndex((t) => t.includes(q));
  if (at !== -1) return at;
  return texts.join(" ").includes(q) ? -1 : null;
}

/** A card's text once she has seen its answer. */
export function cardText(body: unknown, why: string | null): string {
  const b = (body ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const lines: string[] = [];
  switch (b.type) {
    case "basic":
      lines.push(`Question: ${s(b.q)}`, `Answer: ${s(b.a)}`);
      break;
    case "cloze":
      lines.push(`Fill the gap: ${s(b.q).replace(/\{\{([^}]*)\}\}/g, "____")}`);
      lines.push(`Answer: ${s(b.q).replace(/\{\{([^}]*)\}\}/g, "$1")}`);
      break;
    case "mcq": {
      const opts = Array.isArray(b.opts) ? (b.opts as unknown[]) : [];
      lines.push(`Question: ${s(b.q)}`);
      for (const o of opts) if (Array.isArray(o)) lines.push(`- ${s(o[0])}${o[1] === true ? " (correct)" : ""}`);
      break;
    }
    case "match": {
      const pairs = Array.isArray(b.pairs) ? (b.pairs as unknown[]) : [];
      lines.push(`Match: ${s(b.q)}`);
      for (const p of pairs) if (Array.isArray(p)) lines.push(`- ${s(p[0])}: ${s(p[1])}`);
      break;
    }
    case "explain":
      lines.push(`Question: ${s(b.q)}`, `Model answer: ${s(b.model)}`);
      break;
    default:
      return "";
  }
  if (why) lines.push(`Why: ${why}`);
  return cut(lines.join("\n"), SECTION_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Loading what she is on

type CourseRow = { id: string; name: string; aiAssignments: AiAssignments; aiStudy: AiStudy; hidden: boolean };

/** What one place gives: the course, a line for "where she is", and course text (unchecked). */
type Place = {
  courseId: string | null;
  where: string;
  /** Course text with its label; sent only when mayUseFiles says yes. */
  material: { label: string; text: string } | null;
  /** Extra instruction about the place (e.g. "she has not answered yet"). */
  note: string | null;
  anchor: TutorAnchor;
  /** Lecture places: the highlighted passage when it is her lecture's text (course text). */
  passage?: { label: string; text: string } | null;
  /** Lecture places: the concept names of the lecture (course data). */
  concepts?: string[];
};

const ANYWHERE: Place = { courseId: null, where: "", material: null, note: null, anchor: GENERAL };

async function lecturePlace(
  userId: string,
  w: Extract<TutorWhere, { kind: "lecture" }>,
  byId: Map<string, CourseRow>,
  database: Db,
  quote: string | null,
): Promise<Place> {
  const course = byId.get(w.courseId);
  if (!course) return ANYWHERE;
  const [row] = await database
    .select({ id: lectures.id, title: lectures.title, sections: lectureContent.sections })
    .from(lectures)
    .leftJoin(lectureContent, eq(lectureContent.lectureId, lectures.id))
    .where(and(eq(lectures.userId, userId), eq(lectures.courseId, course.id), eq(lectures.n, w.n)))
    .limit(1);
  if (!row) return ANYWHERE;
  const sections = sectionsOf(row.sections ?? []);
  // A passage that is her lecture's text picks its own section; the client's index otherwise.
  const found = quote ? findPassage(sections, quote) : null;
  const asked = Math.min(Math.max(w.section ?? 0, 0), Math.max(sections.length - 1, 0));
  const index = found !== null && found >= 0 ? found : asked;
  const section = sections[index];
  const names = await database
    .select({ name: concepts.name })
    .from(lectureConcepts)
    .innerJoin(concepts, eq(concepts.id, lectureConcepts.conceptId))
    .where(and(eq(lectureConcepts.lectureId, row.id), eq(concepts.userId, userId)))
    .orderBy(asc(concepts.position), asc(concepts.name))
    .limit(CONCEPTS_MAX);
  const title = `Lecture ${w.n}, ${row.title}`;
  return {
    courseId: course.id,
    where: `She is reading lecture ${w.n} of the course "${course.name}": "${row.title}"${section ? `, the section "${section.heading}"` : ""}.`,
    material: section ? { label: `${title}: ${section.heading}`, text: sectionText(section) } : null,
    note: null,
    anchor: { kind: "lecture", id: row.id },
    passage: quote && found !== null ? { label: title, text: cut(quote.trim(), QUOTE_MAX_CHARS) } : null,
    concepts: [...new Set(names.map((n) => n.name))],
  };
}

async function examPlace(userId: string, examId: string, byId: Map<string, CourseRow>, database: Db, now: Date): Promise<Place> {
  const [exam] = await database
    .select({ id: exams.id, title: exams.title, at: exams.at, courseId: exams.courseId })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))
    .limit(1);
  const course = exam ? byId.get(exam.courseId) : undefined;
  if (!exam || !course) return ANYWHERE;
  const deck = await loadDeck(userId, exam.id, database);
  const scored = deck.concepts.map((c) => {
    const own = deck.cards
      .filter((card) => card.conceptIds[0] === c.id)
      .map((card) => ({ state: card.memory?.fsrs ?? newCard(exam.at), active: card.status === "active" }));
    return { name: c.name, mastery: conceptMastery(own, exam.at) };
  });
  const weakest = [...scored]
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, WEAKEST)
    .map((c) => `${c.name} (${Math.round(c.mastery * 100)}% ready)`);
  const lines = [
    `She is on the page of the exam "${exam.title}" (${course.name}), on ${dateLine(exam.at)}${exam.at < now ? ", already past" : ""}.`,
  ];
  if (scored.length) lines.push(`Its concepts: ${scored.map((c) => c.name).join("; ")}.`);
  if (weakest.length) lines.push(`Where she is weakest: ${weakest.join("; ")}.`);
  return { courseId: course.id, where: lines.join("\n"), material: null, note: null, anchor: { kind: "exam", id: exam.id } };
}

async function studyPlace(userId: string, w: Extract<TutorWhere, { kind: "study" }>, byId: Map<string, CourseRow>, database: Db): Promise<Place> {
  const [session] = await database
    .select({ examId: studySessions.examId, title: exams.title, courseId: exams.courseId })
    .from(studySessions)
    .innerJoin(exams, eq(exams.id, studySessions.examId))
    .where(and(eq(studySessions.id, w.sessionId), eq(studySessions.userId, userId), eq(exams.userId, userId)))
    .limit(1);
  const course = session ? byId.get(session.courseId) : undefined;
  if (!session || !course) return ANYWHERE;
  const where = `She is in a study session for the exam "${session.title}" (${course.name}).`;
  // Which card is hers (its id only): the chat belongs to it, before and after she answers it.
  const [own] = w.cardId
    ? await database
        .select({ id: cards.id })
        .from(cards)
        .where(and(eq(cards.id, w.cardId), eq(cards.userId, userId), eq(cards.examId, session.examId)))
        .limit(1)
    : [];
  const anchor: TutorAnchor = own ? { kind: "card", id: own.id } : GENERAL;
  if (!w.revealed || !own) {
    return {
      courseId: course.id,
      where,
      material: null,
      note: "She has not answered the card on her screen yet. Do not guess at it or give away answers to it; help her think, and tell her to answer the card first if she asks what its answer is.",
      anchor,
    };
  }
  const [card] = await database
    .select({ body: cards.body, why: cards.why })
    .from(cards)
    .where(and(eq(cards.id, own.id), eq(cards.userId, userId)))
    .limit(1);
  const text = card ? cardText(card.body, card.why) : "";
  return {
    courseId: course.id,
    where: `${where} She has just answered the card below and may ask about it.`,
    material: text ? { label: "The card she just answered", text } : null,
    note: null,
    anchor,
  };
}

async function assignmentPlace(userId: string, assignmentId: string, byId: Map<string, CourseRow>, database: Db): Promise<Place> {
  const [row] = await database
    .select({ name: assignments.name, dueAt: assignments.dueAt, courseId: assignments.courseId })
    .from(assignments)
    .where(and(eq(assignments.id, assignmentId), eq(assignments.userId, userId)))
    .limit(1);
  const course = row ? byId.get(row.courseId) : undefined;
  if (!row || !course) return ANYWHERE;
  if (assignmentHelp(course) === "off") {
    // Not even the assignment's name: the rule above names the course.
    return {
      courseId: course.id,
      where: `She is on an assignment page of the course "${course.name}".`,
      material: null,
      note: "This course does not allow AI help on its assignments, so you have nothing about this assignment and must not discuss it.",
      anchor: GENERAL,
    };
  }
  return {
    courseId: course.id,
    where: `She is on the page of the assignment "${row.name}" (${course.name})${row.dueAt ? `, due ${dateLine(row.dueAt)}` : ""}. You may explain the ideas it is about, never write any of it.`,
    material: null,
    note: null,
    anchor: GENERAL,
  };
}

async function anywherePlace(userId: string, list: CourseRow[], database: Db, now: Date): Promise<Place> {
  const visible = list.filter((c) => !c.hidden);
  if (visible.length === 0) return ANYWHERE;
  const helpOn = visible.filter((c) => assignmentHelp(c) !== "off").map((c) => c.id);
  const until = new Date(now.getTime() + DUE_DAYS * 86_400_000);
  const name = new Map(visible.map((c) => [c.id, c.name]));
  const [due, upcoming] = await Promise.all([
    helpOn.length
      ? database
          .select({ name: assignments.name, dueAt: assignments.dueAt, courseId: assignments.courseId })
          .from(assignments)
          .where(
            and(
              eq(assignments.userId, userId),
              inArray(assignments.courseId, helpOn),
              isNull(assignments.submittedAt),
              not(inArray(assignments.state, ["submitted", "graded"])),
              gte(assignments.dueAt, now),
              lte(assignments.dueAt, until),
            ),
          )
          .orderBy(asc(assignments.dueAt))
          .limit(DUE_MAX)
      : Promise.resolve([]),
    database
      .select({ title: exams.title, at: exams.at, courseId: exams.courseId })
      .from(exams)
      .where(and(eq(exams.userId, userId), gte(exams.at, now), inArray(exams.courseId, visible.map((c) => c.id))))
      .orderBy(asc(exams.at))
      .limit(DUE_MAX),
  ]);
  const lines = [`Her courses: ${visible.map((c) => c.name).join("; ")}.`];
  if (upcoming.length) {
    lines.push(`Exams coming: ${upcoming.map((e) => `${e.title} (${name.get(e.courseId)}), ${dateLine(e.at)}`).join("; ")}.`);
  }
  if (due.length) {
    lines.push(
      `Due in the next ${DUE_DAYS} days: ${due.map((a) => `${a.name} (${name.get(a.courseId)})${a.dueAt ? `, ${dateLine(a.dueAt)}` : ""}`).join("; ")}.`,
    );
  }
  return { courseId: null, where: lines.join("\n"), material: null, note: null, anchor: GENERAL };
}

async function placeOf(userId: string, where: TutorWhere, list: CourseRow[], database: Db, now: Date, quote: string | null = null): Promise<Place> {
  const byId = new Map(list.filter((c) => !c.hidden).map((c) => [c.id, c]));
  switch (where.kind) {
    case "lecture":
      return lecturePlace(userId, where, byId, database, quote);
    case "exam":
      return examPlace(userId, where.examId, byId, database, now);
    case "study":
      return studyPlace(userId, where, byId, database);
    case "assignment":
      return assignmentPlace(userId, where.assignmentId, byId, database);
    case "other":
      return anywherePlace(userId, list, database, now);
  }
}

async function coursesOf(userId: string, database: Db): Promise<CourseRow[]> {
  if (!z.uuid().safeParse(userId).success) return [];
  return database
    .select({ id: courses.id, name: courses.name, aiAssignments: courses.aiAssignments, aiStudy: courses.aiStudy, hidden: courses.hidden })
    .from(courses)
    .where(eq(courses.userId, userId))
    .orderBy(asc(courses.name));
}

/** The place, with course text only where `mayUseFiles` allows it. */
async function checkedPlace(userId: string, where: TutorWhere, database: Db, now: Date, quote: string | null = null) {
  const list = await coursesOf(userId, database);
  const place = await placeOf(userId, where, list, database, now, quote);
  const allowed = place.courseId ? await mayUseFiles(userId, place.courseId, database) : false;
  const material = allowed ? place.material : null;
  const passage = allowed && material ? (place.passage ?? null) : null;
  const conceptNames = allowed && material ? (place.concepts ?? []) : [];
  const off = list.filter((c) => assignmentHelp(c) === "off").map((c) => c.name);
  return { place, material, passage, conceptNames, off, hasCourse: place.courseId !== null };
}

/** The chat a place belongs to when there is no note (only ids that are hers count). */
export async function tutorAnchor(userId: string, where: TutorWhere, database: Db = defaultDb, now: Date = new Date()): Promise<TutorAnchor> {
  return (await tutorPlace(userId, where, database, now)).anchor;
}

/**
 * The course in view and its study rule (`courses.ai_study`), for the tutor's one question
 * "May Ready use this course's slides ...". Only on a lecture, an exam or a study session of
 * HER course (every id checked as for the context); null anywhere else (Home, an assignment).
 */
export type TutorStudy = { courseId: string; courseName: string; rule: AiStudy };

/** The anchor and the course in view, from one look at the place. */
export async function tutorPlace(
  userId: string,
  where: TutorWhere,
  database: Db = defaultDb,
  now: Date = new Date(),
): Promise<{ anchor: TutorAnchor; study: TutorStudy | null }> {
  const list = await coursesOf(userId, database);
  const place = await placeOf(userId, where, list, database, now);
  const asks = where.kind === "lecture" || where.kind === "exam" || where.kind === "study";
  const course = asks && place.courseId ? list.find((c) => c.id === place.courseId) : undefined;
  return {
    anchor: place.anchor,
    study: course ? { courseId: course.id, courseName: course.name, rule: course.aiStudy } : null,
  };
}

export type BuildOptions = {
  /** No answer yet in this chat: the "no material" line asks to say so once, now. */
  firstAnswer?: boolean;
  now?: Date;
  /** The passage she highlighted (or the note's quote), as she sent it. */
  quote?: string | null;
};

/** The tutor's system prompt for one message, in parts (see the header for the order). */
export async function buildTutorContext(
  userId: string,
  where: TutorWhere,
  options: BuildOptions = {},
  database: Db = defaultDb,
): Promise<TutorContext> {
  const now = options.now ?? new Date();
  const quote = options.quote?.trim() ? options.quote.trim() : null;
  const { place, material, passage, conceptNames, off } = await checkedPlace(userId, where, database, now, quote);
  // A passage that is not her lecture's text is her own words; one that is, but may not be
  // sent (study not allowed), is course text and stays out.
  const isCourse = place.passage != null;
  const herWords = quote && !isCourse ? cut(quote, QUOTE_MAX_CHARS) : null;

  const parts: SystemPart[] = [{ text: [RULES, DATA_RULE].join("\n\n") }];
  if (off.length) parts.push({ text: offCoursesRule(off) });
  if (material) {
    // The passage first, then the section it sits in, then the lecture's concepts.
    const blocks: string[] = [];
    if (passage) blocks.push(asData(`The passage she highlighted (${passage.label})`, passage.text));
    blocks.push(asData(passage ? `The section it sits in (${material.label})` : material.label, material.text));
    if (conceptNames.length) blocks.push(asData("Concepts of this lecture", conceptNames.join("; ")));
    parts.push({ text: `Her course material for this question:\n${blocks.join("\n")}`, cache: true });
  }
  const volatile: string[] = [];
  if (place.where) volatile.push(asData("Where she is in Ready", place.where));
  if (place.note) volatile.push(place.note);
  if (passage) volatile.push(PASSAGE_RULE);
  if (herWords) volatile.push(`${asData("Text she quoted", herWords)}\n${HER_WORDS_RULE}`);
  if (!material) volatile.push(options.firstAnswer === false ? NO_MATERIAL_AGAIN : NO_MATERIAL_FIRST);
  parts.push({ text: volatile.join("\n\n") });

  return {
    parts,
    courseText: material !== null,
    courseId: place.courseId,
    anchor: place.anchor,
    quote: quote ? { text: quote, course: isCourse, sent: passage !== null || herWords !== null } : null,
  };
}

// ---------------------------------------------------------------------------
// "Copy for Claude"

export type CopyPrompt = {
  /** The text that goes on her clipboard. */
  text: string;
  /** True when course text is in it. */
  courseText: boolean;
  /** A line to show her under the button, or null. */
  note: string | null;
};

export const COPY_NO_COURSE_TEXT =
  "Copied without course text: this course does not allow AI for studying, or your switch for course files is off.";

const COPY_HEAD = [
  "Be my tutor. I'm a university student preparing for an exam.",
  "Explain from zero, as if I have never seen this. Then show one small worked example with real numbers, step by step.",
  "One idea at a time, short. End with one short question so I can check that I understood.",
  "Answer in the language I write in. Write formulas in plain characters.",
  "Do not write any assignment answer or text for me to hand in; explain the idea instead.",
].join("\n");

/**
 * A ready-made study prompt for her own Claude chat. Nothing is sent anywhere: it is text for
 * the clipboard. Course text (the lecture section, the card after she answered it) only for a
 * course whose study rule allows AI (`mayUseFiles`); never assignment text.
 */
export async function buildCopyPrompt(
  userId: string,
  where: TutorWhere,
  question: string,
  options: { now?: Date } = {},
  database: Db = defaultDb,
): Promise<CopyPrompt> {
  const now = options.now ?? new Date();
  const { place, material, hasCourse } = await checkedPlace(userId, where, database, now);
  const q = question.trim();
  const lines = [COPY_HEAD, "", `My question: ${q || "(I will ask in my next message.)"}`];
  if (material) {
    lines.push("", `Here is the part of my course material I'm on (${material.label}):`, "---", material.text, "---");
  }
  const lostText = hasCourse && !material && place.material !== null;
  return { text: lines.join("\n"), courseText: material !== null, note: lostText ? COPY_NO_COURSE_TEXT : null };
}

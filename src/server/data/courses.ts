/**
 * The Courses list and one course's page (M9-08), ready to draw.
 * Source: prototype merged.html JS 5291-5300 (renderCourseList) and 5326-5357
 * (coursePageHTML).
 *
 *   const list = await getCoursesList(userId, { now });
 *   const page = await getCoursePage(userId, courseId, { now });  // null: 404
 *
 * Reads our database only, through M9-03's `listCourses` / `courseView`
 * (src/server/courses/store.ts) plus the bits those leave out. Only her rows;
 * another user's course, a hidden one, an unknown or malformed id all give
 * `null`.
 *
 * Choices:
 * - Short name: synced names look like "Forecasting Methods, Lecture,
 *   1.9.2026-18.12.2026" (Moodle's `shortname` column is "<code>_aalto-cur-…",
 *   not for people). `shortNameOf` keeps the part before the first comma; a
 *   name without one is kept whole. The course page's heading uses it too.
 * - "Lecture 4 of 6": the first lecture she has not read (current, upcoming or
 *   not posted yet) of all listed lectures; "All 6 read" when every one is
 *   read. The card's bar is read / listed, as the prototype draws it.
 * - "Your four courses this period.": number words up to twelve, digits after.
 * - Forecast chip and finish forecast: the finish exam's forecast today,
 *   computed the way the exam page does (src/server/study/actions.ts:
 *   mastery per concept from cards whose first concept it is, then
 *   `forecastNow`), rounded. Only when the finish is an exam that has
 *   concepts; an exam with none has nothing to forecast yet.
 * - A stop's line: the first sentence of the lecture page's "in one breath"
 *   paragraph (M9-05), "" until that page exists.
 * - A read stop's cards: of the lecture's active cards (see store.ts), how
 *   many she has reviewed at least once. Left out when the lecture has none.
 * - Flags: "<name> · handed in" (mint) once submitted or graded, else
 *   "<name> · due today 21:00", "<name> · due Thu 19 Nov" or
 *   "<name> · due date to come" (butter). Grades on flags wait for M6.
 * - Finish: an exam or quiz is "<title> · Fri 20 Nov 09:00" (a button to the
 *   exam); a last deadline "<name> · due Fri 18 Dec" or "· handed in"; with
 *   neither, the course's end date from its name, "Course ends · Fri 18 Dec",
 *   else "Course ends · date to come", in the course's colour.
 * - No lectures recognised: no path; her course files instead (not files
 *   attached to an assignment), by section then name.
 *
 * Cut: the grade chip ("4.5 on this trajectory" / "No grades yet") until M6-08.
 */
import { and, asc, countDistinct, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { forecastNow } from "@/lib/study/forecast";
import { conceptMastery } from "@/lib/study/ladder";
import { newCard } from "@/lib/study/memory";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { lectureConcepts, lectureContent, lectures } from "@/server/db/schema/learn";
import { cardConcepts, cardStates, cards } from "@/server/db/schema/study";
import {
  CourseNotFound,
  courseView,
  listCourses,
  type CourseColor,
  type CourseFinish,
  type DeadlineFlag,
} from "@/server/courses/store";
import { loadDeck } from "@/server/study/store";

const TIME_ZONE = "Europe/Helsinki";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LectureState = "done" | "cur" | "up" | "soon";
export type Tone = "butter" | "mint" | "sky" | "blush";

export type CourseCard = {
  id: string;
  href: string;
  /** "Forecasting Methods". */
  short: string;
  code: string | null;
  color: CourseColor;
  /** "Lecture 4 of 6", "All 6 read", or "No lectures found". */
  lectureLine: string;
  /** "3 read"; "" when the course has no lectures. */
  readLine: string;
  /** Read / listed, 0 to 1. */
  progress: number;
};

export type CoursesList = {
  /** "Your four courses this period." */
  line: string;
  courses: CourseCard[];
};

/** Same shape as the path's `CoursePathLecture`, plus where the stop goes. */
export type CoursePageLecture = {
  n: number;
  title: string;
  line: string;
  state: LectureState;
  cards: { seen: number; total: number } | null;
  opens: string | null;
  href: string;
};

export type CoursePageFlag = { id: string; after: number; text: string; tone: Tone };

export type CoursePageFinish = {
  text: string;
  exam: { id: string; forecast: number } | null;
  tone: Tone;
  /** The exam page, when the finish is an exam. */
  href: string | null;
};

export type CoursePageFile = { id: string; name: string; section: string | null };

export type CoursePage = {
  id: string;
  /** Heading: the short name. */
  name: string;
  code: string | null;
  color: CourseColor;
  /** Stat chips in order: "Lecture 5 of 8" (when it has lectures), "64% forecast for the exam" (when it has one). */
  stats: string[];
  /** The path, or null when no lectures were recognised. */
  path: { lectures: CoursePageLecture[]; flags: CoursePageFlag[]; finish: CoursePageFinish } | null;
  /** Her course files, only when `path` is null. */
  files: CoursePageFile[];
};

// ---------------------------------------------------------------------------
// Words

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** "four" for 4, up to twelve; digits after. */
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** "Your four courses this period." */
export function coursesLine(count: number): string {
  if (count === 0) return "No courses this period yet.";
  return `Your ${numberWord(count)} ${count === 1 ? "course" : "courses"} this period.`;
}

/** "Forecasting Methods, Lecture, 1.9.2026-18.12.2026" gives "Forecasting Methods". */
export function shortNameOf(name: string): string {
  const head = name.split(",")[0].trim();
  return head || name.trim();
}

/** The end date in a synced name ("…, 1.9.2026-18.12.2026"), as Helsinki noon. */
export function endDateOf(name: string): Date | null {
  const m = name.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d, 10));
  return at.getUTCDate() === d && at.getUTCMonth() === mo - 1 ? at : null;
}

/** "Lecture 4 of 6" for the first one not read, "All 6 read" when none is left. */
export function lectureLine(list: readonly { n: number; state: LectureState }[]): string {
  if (list.length === 0) return "No lectures found";
  const next = list.find((l) => l.state !== "done");
  return next ? `Lecture ${next.n} of ${list.length}` : `All ${list.length} read`;
}

function parts(at: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at)) {
    out[p.type] = p.value;
  }
  return out;
}

/** "Fri 20 Nov". */
export function dayText(at: Date): string {
  const p = parts(at);
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** "Fri 20 Nov 09:00". */
export function dayTimeText(at: Date): string {
  const p = parts(at);
  return `${dayText(at)} ${p.hour}:${p.minute}`;
}

function sameHelsinkiDay(a: Date, b: Date): boolean {
  return dayText(a) === dayText(b) && Math.abs(a.getTime() - b.getTime()) < 36 * 3600 * 1000;
}

const handedIn = (state: DeadlineFlag["state"]) => state === "submitted" || state === "graded";

export function flagText(name: string, dueAt: Date | null, state: DeadlineFlag["state"], now: Date): string {
  if (handedIn(state)) return `${name} · handed in`;
  if (!dueAt) return `${name} · due date to come`;
  if (sameHelsinkiDay(dueAt, now)) return `${name} · due today ${parts(dueAt).hour}:${parts(dueAt).minute}`;
  return `${name} · due ${dayText(dueAt)}`;
}

function firstSentence(text: string | null): string {
  const t = text?.trim() ?? "";
  if (!t) return "";
  const m = t.match(/^[\s\S]+?[.!?](?=\s|$)/);
  return (m ? m[0] : t).trim();
}

const lectureHref = (courseId: string, n: number) => `/courses/${encodeURIComponent(courseId)}/lectures/${n}`;
const examHref = (examId: string) => `/exams/${encodeURIComponent(examId)}`;
const courseHref = (courseId: string) => `/courses/${encodeURIComponent(courseId)}`;

// ---------------------------------------------------------------------------
// List

export async function getCoursesList(
  userId: string,
  options: { now: Date },
  database: Db = defaultDb,
): Promise<CoursesList> {
  const list = await listCourses(userId, database, options.now);
  const ids = list.map((c) => c.id);
  const rows = ids.length
    ? await database
        .select({ courseId: lectures.courseId, n: lectures.n, opensAt: lectures.opensAt, readAt: lectures.readAt })
        .from(lectures)
        .where(and(eq(lectures.userId, userId), inArray(lectures.courseId, ids)))
        .orderBy(asc(lectures.n))
    : [];

  const cardsOut: CourseCard[] = list.map((c) => {
    const mine = rows
      .filter((r) => r.courseId === c.id)
      .map((r) => ({ n: r.n, state: (r.readAt ? "done" : "up") as LectureState }));
    const read = mine.filter((l) => l.state === "done").length;
    return {
      id: c.id,
      href: courseHref(c.id),
      short: shortNameOf(c.name),
      code: c.code,
      color: c.color,
      lectureLine: lectureLine(mine),
      readLine: mine.length ? `${read} read` : "",
      progress: mine.length ? read / mine.length : 0,
    };
  });
  return { line: coursesLine(cardsOut.length), courses: cardsOut };
}

// ---------------------------------------------------------------------------
// One course

/** The exam's forecast today, rounded; null when it has no concepts. Same mapping as the exam page. */
async function examForecast(userId: string, examId: string, examAt: Date, database: Db): Promise<number | null> {
  const deck = await loadDeck(userId, examId, database);
  if (deck.concepts.length === 0) return null;
  const weighted = deck.concepts.map((concept) => {
    const own = deck.cards
      .filter((c) => c.conceptIds[0] === concept.id)
      .map((c) => ({ state: c.memory?.fsrs ?? newCard(examAt), active: c.status === "active" }));
    return { weight: concept.weight, mastery: conceptMastery(own, examAt) };
  });
  return Math.round(forecastNow(weighted));
}

function finishOf(
  finish: CourseFinish | null,
  forecast: number | null,
  courseName: string,
  color: CourseColor,
  now: Date,
): CoursePageFinish {
  if (finish?.kind === "exam") {
    return {
      text: `${finish.title} · ${dayTimeText(finish.at)}`,
      exam: forecast === null ? null : { id: finish.examId, forecast },
      tone: "blush",
      href: examHref(finish.examId),
    };
  }
  if (finish?.kind === "deadline") {
    return { text: flagText(finish.title, finish.at, finish.state, now), exam: null, tone: color, href: null };
  }
  const end = endDateOf(courseName);
  return { text: `Course ends · ${end ? dayText(end) : "date to come"}`, exam: null, tone: color, href: null };
}

export async function getCoursePage(
  userId: string,
  courseId: string,
  options: { now: Date },
  database: Db = defaultDb,
): Promise<CoursePage | null> {
  const { now } = options;
  if (!UUID.test(courseId)) return null;
  const [row] = await database
    .select({ hidden: courses.hidden })
    .from(courses)
    .where(and(eq(courses.id, courseId), eq(courses.userId, userId)));
  if (!row || row.hidden) return null;

  let view;
  try {
    view = await courseView(userId, courseId, database, now);
  } catch (err) {
    if (err instanceof CourseNotFound) return null;
    throw err;
  }
  const { course } = view;

  const forecast =
    view.finish?.kind === "exam" ? await examForecast(userId, view.finish.examId, view.finish.at, database) : null;
  const stats: string[] = [];
  if (view.lectures.length) stats.push(lectureLine(view.lectures));
  if (forecast !== null && view.finish?.kind === "exam") stats.push(`${forecast}% forecast for the ${view.finish.examKind}`);

  const base = { id: course.id, name: shortNameOf(course.name), code: course.code, color: course.color, stats };

  if (view.lectures.length === 0) {
    const files = await database
      .select({ id: courseFiles.id, name: courseFiles.name, section: courseFiles.section })
      .from(courseFiles)
      .where(and(eq(courseFiles.userId, userId), eq(courseFiles.courseId, courseId), isNull(courseFiles.assignmentId)))
      .orderBy(asc(courseFiles.section), asc(courseFiles.name), asc(courseFiles.id));
    return { ...base, path: null, files };
  }

  const ids = view.lectures.map((l) => l.id);
  const breaths = await database
    .select({ lectureId: lectureContent.lectureId, breath: lectureContent.breath })
    .from(lectureContent)
    .where(inArray(lectureContent.lectureId, ids));
  const lineOf = new Map(breaths.map((b) => [b.lectureId, firstSentence(b.breath)]));

  const seenRows = await database
    .select({ lectureId: lectureConcepts.lectureId, n: countDistinct(cards.id) })
    .from(lectureConcepts)
    .innerJoin(cardConcepts, eq(cardConcepts.conceptId, lectureConcepts.conceptId))
    .innerJoin(cards, eq(cards.id, cardConcepts.cardId))
    .innerJoin(cardStates, eq(cardStates.cardId, cards.id))
    .where(
      and(
        inArray(lectureConcepts.lectureId, ids),
        eq(cards.userId, userId),
        eq(cards.status, "active"),
        isNotNull(cardStates.lastReviewAt),
      ),
    )
    .groupBy(lectureConcepts.lectureId);
  const seenOf = new Map(seenRows.map((r) => [r.lectureId, Number(r.n)]));

  const list: CoursePageLecture[] = view.lectures.map((l) => ({
    n: l.n,
    title: l.title,
    line: lineOf.get(l.id) ?? "",
    state: l.state,
    cards: l.cards > 0 ? { seen: Math.min(l.cards, seenOf.get(l.id) ?? 0), total: l.cards } : null,
    opens: l.state === "soon" && l.opensAt ? dayText(l.opensAt) : null,
    href: lectureHref(course.id, l.n),
  }));

  const flags: CoursePageFlag[] = view.flags.map((f) => ({
    id: f.assignmentId,
    after: f.after,
    text: flagText(f.title, f.dueAt, f.state, now),
    tone: handedIn(f.state) ? "mint" : "butter",
  }));

  return {
    ...base,
    path: { lectures: list, flags, finish: finishOf(view.finish, forecast, course.name, course.color, now) },
    files: [],
  };
}

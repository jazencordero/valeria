/**
 * Home's data (M1-27): her first name, her Moodle connection's status, what to
 * do first, what comes after, and the newest hand-in.
 *
 * Reads our database only. The open list and the done list come from
 * `getAssignmentsView` (M1-28), so Home and the Assignments tab always agree on
 * order (`buildQueue`), status chips (Not started / Draft saved / NEW), hrefs
 * and which courses count (hidden ones are left out). Home adds:
 * - `first`: the head of the open list, plus its course code for the hero card.
 * - `then`: the rest of the open list.
 * - `lastDone`: the newest hand-in of the last 7 days (`DONE_WINDOW_MS`), plus
 *   its due time for "5 h 8 min early". Home shows it when nothing is open.
 * - `connection`: `null` when she has never connected (the page sends her to
 *   /connect), else its status ('expired' shows the sign-in banner).
 *
 * M3-44 adds the bite row and the exam cards:
 * - `exams`: her upcoming exams and quizzes, soonest first, past ones left
 *   out. An exam whose clock time is a placeholder is a whole-day exam: it
 *   stays today's exam, with its bite, until its Helsinki day ends, and
 *   nothing here prints a time for it (`getExamsView`). They are the Exams tab's list (`getExamsView`, M3-41), so Home,
 *   /exams and /exams/<id> show the same forecast, phase and counts: every
 *   number comes from M3-18's `examView`, read once per exam. Home adds what
 *   its card shows on top: the verdict, the concept icons and today's bite
 *   minutes. The grade on the card ("A 4 needs 85%") is the one her bundle
 *   names (`exams.grade_target`), never one worked out from the percent.
 * - `bite`: which exam the row is for. The soonest upcoming exam whose
 *   `examView` has a bite today (it has cards and today's plan is not done)
 *   gets "Or a 5-minute bite for Friday's exam". With none, the soonest exam
 *   whose plan is done today (`bitesDoneToday >= bitesPerDay`, M3-08) gets
 *   "Today's bites are done". Otherwise there is no row: no exam has cards,
 *   or the deck has nothing for a bite yet. That covers M3-53's study start
 *   too: before `start_new_on` `examView` builds no bite from never-graded
 *   cards, so a fresh exam shows no row instead of a done one.
 *   A paced exam (its deck has core marks, `ExamView.pace`) is never done by
 *   the number of bites: its row says how many bites today keeps her on plan
 *   ("3 bites today keeps you on track for Monday"; when the plan ends below
 *   her target, "3 bites today. The plan gets you to about 62% by Monday":
 *   `todayLine`, from the same plan as the verdict), and it is done when
 *   `pace.done` says so (today's new cards are used and nothing is due).
 * - `biteFirst`: nothing is open, so the bite is the DO FIRST card.
 *
 * M4-10 adds the greeting and the week:
 * - `greeting`: M4-06's `greeting()` sentence. Its queue is the open list
 *   above (same order), its exam the bite row's exam (the "or a 5-minute
 *   bite" offer names the exam the bite row is for, and none when there is
 *   no bite). `options.flash` is what she just did (`flash.ts`): a hand-in
 *   names `lastDone`, the newest hand-in, which the hand-in has just
 *   written; a session names its exam from the list above with the forecast
 *   the done screen showed. A flash whose hand-in or exam is not there (a
 *   hidden course, a past exam) is ignored and the usual sentence is shown.
 * - `week`: M4-08's `weekModel()` for the THIS WEEK card. Items are her
 *   visible open and handed-in assignments with a due time (handed-in ones
 *   mark their due day done), her upcoming exams (`kind: "exam"`) and quizzes
 *   (`"quiz"`, which count as deadlines). `weekModel` keeps the 7 days.
 *
 * M6-09 adds the grades card:
 * - `grades`: the Grades tab's rows (`getGradesList`, M6-08), so Home and
 *   /grades show the same courses (visible ones, by name), statuses, targets
 *   and trajectories. Each row's `href` is its grade page, `/grades/<id>`.
 *
 * M7-04 adds Never miss one:
 * - `neverMiss.dateCount`: how many dates her calendar link lists now
 *   (M7-02's `itemsForUser`, the same rows the feed serves).
 * - `neverMiss.on`: what she turned on (`users.settings.neverMiss`, written by
 *   `src/app/(app)/home/never-miss-actions.ts`), or null. The calendar counts
 *   as on only while her link exists: a revoked link means off.
 * - `neverMiss.dismissed`: she said "Not now" (`neverMiss.notNowAt`) under 30
 *   days ago (`NOT_NOW_DAYS`, as the card's own localStorage snooze). Home then
 *   leaves the card out, so it does not render and fade out on every visit.
 *
 * M9-19 adds "pick up where you left off":
 * - `pickup`: one lecture to continue, or null (no row). Only her visible
 *   courses count, and "unread" and "current" are M9-03's `courseView` states
 *   (the course path's): the current lecture is the first posted one she has
 *   not read. In order:
 *   1. The current lecture of the course whose exam is nearest (the exam
 *      cards' order). An exam course with nothing unread passes to the next.
 *   2. With no exams (or none of their courses with anything unread): the
 *      lecture she opened last (`lectures.last_opened_at`, else `read_at`,
 *      the newer of the two). If that one is unread it is the row; if it is
 *      read, its course's current lecture; else the next one she opened.
 *   3. Else the first of her courses, by name, with a current lecture.
 *   Nothing unread anywhere: null. Minutes are M9-05's `lecture_content`
 *   reading time, null until the page is written.
 *   Note: nothing writes `last_opened_at` yet (the lecture page does not), so
 *   until it does, step 2 goes by the lecture she marked read last.
 *
 * Later Home tickets extend `HomeView` here.
 */
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { byDay, TIME_ZONE } from "@/lib/dates";
import { greeting, type GreetingAssignment, type JustHandedIn, type JustStudied, type NextExam } from "@/lib/home/greeting";
import { todayLine } from "@/lib/study/plan";
import { WEEK_DAYS, weekModel, type WeekItem, type WeekModel } from "@/lib/home/week";
import { DONE_WINDOW_MS, type Queue } from "@/lib/queue";
import { FEED_PROVIDERS, itemsForUser, type FeedProvider } from "@/server/calendar/feed";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courseView, listCourses, type CourseLecture } from "@/server/courses/store";
import { calendarFeeds } from "@/server/db/schema/calendar";
import { courses } from "@/server/db/schema/courses";
import { MOODLE_STATUSES, moodleConnections } from "@/server/db/schema/moodle";
import { lectureContent, lectures } from "@/server/db/schema/learn";
import { exams as examsTable } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { examView, type ExamView } from "@/server/study/actions";
import { getAssignmentsView, type DoneAssignment, type OpenAssignment } from "./assignments";
import { getExamsView, type ExamsTabExam, type ExamViewLoader } from "./exams";
import { getGradesList, type GradesListRow } from "./grades";
import { lectureHref } from "./lecture";
import type { Flash } from "./flash";

export type HomeConnection = { status: (typeof MOODLE_STATUSES)[number] };

export type HomeFirst = OpenAssignment & {
  /** Course code for the hero card, for example ISM-E1005. `null` when Moodle gave none. */
  code: string | null;
};

export type HomeDone = DoneAssignment & {
  /** When it was due, for "5 h 8 min early". `null` when there was no due date. */
  dueAt: Date | null;
};

export type HomeExam = Omit<ExamsTabExam, "concepts"> & {
  verdict: { text: string; ok: boolean };
  /** `examView`'s concept icon name, or null (the page picks one by name). */
  concepts: { id: string; name: string; rung: number; icon: string | null }[];
  /** Minutes of today's bite, or null when there is none (the card says "Open the exam"). */
  biteMinutes: number | null;
  /** Where today's bite starts: `/study/new?exam=<id>&kind=bite` (M3-42's convention). */
  biteHref: string;
};

export type HomeBite =
  | {
      state: "bite";
      examId: string;
      minutes: number;
      cards: number;
      /** Forecast points the bite is worth if every card is recalled, not rounded (`Bite.gain`). */
      gain: number;
      /** "Friday's exam", "tomorrow's quiz", "the exam on 4 Dec". */
      forWhat: string;
      href: string;
      /** A paced exam: "3 bites today keeps you on track for Monday". */
      pace?: string;
    }
  | {
      state: "done";
      examId: string;
      /** Forecast shown today, a whole percent. */
      forecast: number;
      /** "FRIDAY", "TOMORROW", "4 DEC". */
      day: string;
      /** `/exams/<id>`. */
      href: string;
    };

/** What she turned on in Never miss one (the card's `NeverMissChoice`). */
export type HomeNeverMissOn = { calendar: FeedProvider | null; reminders: "push" | "email" | null };

export type HomeNeverMiss = {
  /** Dates her calendar link lists now. */
  dateCount: number;
  /** What is on, or null: the card shows. */
  on: HomeNeverMissOn | null;
  /** "Not now" under `NOT_NOW_DAYS` ago: no card. */
  dismissed: boolean;
};

/** How long "Not now" hides the card (M7-03's `NOT_NOW_MS`, which is client-only). */
export const NOT_NOW_DAYS = 30;

/** Whether `users.settings.neverMiss.notNowAt` still hides the card at `now`. */
export function neverMissDismissed(settings: Record<string, unknown> | null | undefined, now: Date): boolean {
  const raw = settings?.neverMiss;
  if (!raw || typeof raw !== "object") return false;
  const at = Date.parse(String((raw as { notNowAt?: unknown }).notNowAt ?? ""));
  if (!Number.isFinite(at)) return false;
  const age = now.getTime() - at;
  return age >= 0 && age < NOT_NOW_DAYS * DAY_MS;
}

/**
 * `users.settings.neverMiss` as Home reads it. `hasFeed`: her calendar link exists.
 * Anything malformed, or nothing left on, reads as null.
 */
export function neverMissOn(settings: Record<string, unknown> | null | undefined, hasFeed: boolean): HomeNeverMissOn | null {
  const raw = settings?.neverMiss;
  if (!raw || typeof raw !== "object") return null;
  const { calendar, reminders } = raw as { calendar?: unknown; reminders?: unknown };
  const cal =
    hasFeed && typeof calendar === "string" && (FEED_PROVIDERS as readonly string[]).includes(calendar)
      ? (calendar as FeedProvider)
      : null;
  const rem = reminders === "push" || reminders === "email" ? reminders : null;
  return cal || rem ? { calendar: cal, reminders: rem } : null;
}

/** "Pick up where you left off": the lecture Continue opens. */
export type HomePickup = {
  courseId: string;
  lectureId: string;
  n: number;
  title: string;
  /** Reading time, or null while the lecture page is still being written. */
  minutes: number | null;
  /** The lecture page, `/courses/<id>/lectures/<n>`. */
  href: string;
};

export type HomeView = {
  /** First word of her display name, or `null` when we have none. */
  firstName: string | null;
  connection: HomeConnection | null;
  first: HomeFirst | null;
  then: OpenAssignment[];
  lastDone: HomeDone | null;
  exams: HomeExam[];
  bite: HomeBite | null;
  /** True when nothing is open and there is a bite: the bite is the DO FIRST card. */
  biteFirst: boolean;
  /** The sentence in Vitonen's bubble. */
  greeting: string;
  /** The THIS WEEK card. */
  week: WeekModel;
  /** The grades card: one row per visible course, as on /grades. */
  grades: GradesListRow[];
  /** The Never miss one card, under the grades card. */
  neverMiss: HomeNeverMiss;
  /** "Pick up where you left off", under the exam cards; null: no row. */
  pickup: HomePickup | null;
};

/** "Valeria Example" gives "Valeria"; empty or missing gives null. */
export function firstNameOf(displayName: string | null | undefined): string | null {
  const first = displayName?.trim().split(/\s+/)[0];
  return first ? first : null;
}

const weekdayOf = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, weekday: "long" });
const dayMonthOf = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, day: "numeric", month: "short" });

/** Within a week the weekday names the exam; further out, its date. */
function dayWord(at: Date, daysLeft: number): { word: string; date: boolean } {
  if (daysLeft <= 0) return { word: "today", date: false };
  if (daysLeft === 1) return { word: "tomorrow", date: false };
  if (daysLeft < 7) return { word: weekdayOf.format(at), date: false };
  return { word: dayMonthOf.format(at), date: true };
}

/** "Friday's exam", "today's quiz", "the exam on 4 Dec". */
export function biteFor(kind: "exam" | "quiz", at: Date, daysLeft: number): string {
  const { word, date } = dayWord(at, daysLeft);
  return date ? `the ${kind} on ${word}` : `${word}\u2019s ${kind}`;
}

/** "FRIDAY", "TODAY", "4 DEC". */
export function biteDay(at: Date, daysLeft: number): string {
  return dayWord(at, daysLeft).word.toUpperCase();
}

const biteHref = (examId: string) => `/study/new?exam=${encodeURIComponent(examId)}&kind=bite`;

function homeExam(card: ExamsTabExam, v: ExamView): HomeExam {
  const icons = new Map(v.concepts.map((c) => [c.id, c.icon]));
  return {
    ...card,
    verdict: { text: v.verdict.text, ok: v.verdict.ok },
    concepts: card.concepts.map((c) => ({ ...c, icon: icons.get(c.id) ?? null })),
    biteMinutes: v.bite?.minutes ?? null,
    biteHref: biteHref(card.id),
  };
}

function pickBite(list: ExamsTabExam[], views: Map<string, ExamView>, now: Date): HomeBite | null {
  for (const card of list) {
    const v = views.get(card.id);
    if (!v?.bite) continue;
    const pace = v.pace ? todayLine(v.pace, v.plan, byDay(v.exam.at, now), { more: v.bitesDoneToday > 0 }) : null;
    return {
      state: "bite",
      examId: card.id,
      minutes: v.bite.minutes,
      cards: v.bite.cards,
      gain: v.bite.gain,
      forWhat: biteFor(card.kind, v.exam.at, v.daysLeft),
      href: biteHref(card.id),
      ...(pace ? { pace } : {}),
    };
  }
  for (const card of list) {
    const v = views.get(card.id);
    if (!v || !(v.pace ? v.pace.done : v.bitesDoneToday >= v.bitesPerDay)) continue;
    return { state: "done", examId: card.id, forecast: v.forecastShown, day: biteDay(v.exam.at, v.daysLeft), href: card.href };
  }
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The open list as `greeting()`'s queue. The greeting reads only the order,
 * titles and due times; the other queue fields are filled to satisfy the type.
 */
function greetingQueue(open: OpenAssignment[], now: Date): Queue<GreetingAssignment> {
  const rows: GreetingAssignment[] = open.map((a) => ({
    id: a.id,
    title: a.title,
    due_at: a.dueAt,
    submitted_at: null,
    first_seen_at: now,
    seen_at: null,
    from_first_sync: true,
  }));
  return { first: rows[0] ?? null, then: rows.slice(1), done: [] };
}

/** What she just did, as `greeting()` takes it. Both null when the flash names nothing on Home. */
export function reactionTo(
  flash: Flash | null | undefined,
  lastDone: HomeDone | null,
  views: ReadonlyMap<string, ExamView>,
  /** Ids of the exams whose time is a placeholder: "today's exam" all of that day. */
  wholeDay: ReadonlySet<string> = new Set(),
): { justHandedIn: JustHandedIn | null; justStudied: JustStudied | null } {
  if (flash?.kind === "handedIn" && lastDone) {
    return {
      justHandedIn: { title: lastDone.title, submittedAt: lastDone.submittedAt, dueAt: lastDone.dueAt },
      justStudied: null,
    };
  }
  if (flash?.kind === "studied") {
    const v = views.get(flash.examId);
    if (v) {
      return {
        justHandedIn: null,
        justStudied: { examTitle: v.exam.title, forecast: flash.forecast, examAt: v.exam.at, wholeDay: wholeDay.has(flash.examId) },
      };
    }
  }
  return { justHandedIn: null, justStudied: null };
}

async function neverMissFor(
  userId: string,
  settings: Record<string, unknown> | undefined,
  now: Date,
  database: Db,
): Promise<HomeNeverMiss> {
  const [feed] = await database
    .select({ userId: calendarFeeds.userId })
    .from(calendarFeeds)
    .where(eq(calendarFeeds.userId, userId))
    .limit(1);
  const items = await itemsForUser(userId, database);
  return {
    dateCount: items.length,
    on: neverMissOn(settings, !!feed),
    dismissed: neverMissDismissed(settings, now),
  };
}

const unread = (l: CourseLecture) => l.state === "cur" || l.state === "up";

/**
 * Which lecture "pick up where you left off" names (see the header).
 * `examIds`: her upcoming exams, nearest first.
 */
export async function pickupFor(
  userId: string,
  examIds: readonly string[],
  now: Date,
  database: Db = defaultDb,
): Promise<HomePickup | null> {
  const visible = await listCourses(userId, database, now);
  if (visible.length === 0) return null;
  const views = await Promise.all(visible.map((c) => courseView(userId, c.id, database, now)));
  const byCourse = new Map(views.map((v) => [v.course.id, v.lectures]));
  const current = (courseId: string) => byCourse.get(courseId)?.find((l) => l.state === "cur") ?? null;

  let pick: { courseId: string; lecture: CourseLecture } | null = null;

  // 1. The nearest exam's course.
  if (examIds.length > 0) {
    const rows = await database
      .select({ id: examsTable.id, courseId: examsTable.courseId })
      .from(examsTable)
      .where(and(eq(examsTable.userId, userId), inArray(examsTable.id, [...examIds])));
    const courseOf = new Map(rows.map((r) => [r.id, r.courseId]));
    for (const id of examIds) {
      const courseId = courseOf.get(id);
      const cur = courseId ? current(courseId) : null;
      if (courseId && cur) {
        pick = { courseId, lecture: cur };
        break;
      }
    }
  }

  // 2. The lecture she opened last.
  if (!pick) {
    const touched = await database
      .select({ id: lectures.id, courseId: lectures.courseId, openedAt: lectures.lastOpenedAt, readAt: lectures.readAt })
      .from(lectures)
      .where(and(eq(lectures.userId, userId), inArray(lectures.courseId, [...byCourse.keys()])));
    const at = (r: (typeof touched)[number]) => Math.max(r.openedAt?.getTime() ?? -Infinity, r.readAt?.getTime() ?? -Infinity);
    const recent = touched.filter((r) => Number.isFinite(at(r))).sort((a, b) => at(b) - at(a) || a.id.localeCompare(b.id));
    for (const r of recent) {
      const lecture = byCourse.get(r.courseId)?.find((l) => l.id === r.id);
      const chosen = lecture && unread(lecture) ? lecture : current(r.courseId);
      if (chosen) {
        pick = { courseId: r.courseId, lecture: chosen };
        break;
      }
    }
  }

  // 3. The first course, by name, with something unread.
  if (!pick) {
    for (const c of visible) {
      const cur = current(c.id);
      if (cur) {
        pick = { courseId: c.id, lecture: cur };
        break;
      }
    }
  }
  if (!pick) return null;

  const [content] = await database
    .select({ minutes: lectureContent.minutes })
    .from(lectureContent)
    .where(eq(lectureContent.lectureId, pick.lecture.id))
    .limit(1);
  return {
    courseId: pick.courseId,
    lectureId: pick.lecture.id,
    n: pick.lecture.n,
    title: pick.lecture.title,
    minutes: content?.minutes ?? null,
    href: lectureHref(pick.courseId, pick.lecture.n),
  };
}

export async function getHomeView(
  userId: string,
  options: { now: Date; view?: ExamViewLoader; flash?: Flash | null },
  database: Db = defaultDb,
): Promise<HomeView> {
  const { now, view: load = examView, flash = null } = options;

  const [me] = await database
    .select({ displayName: users.displayName, settings: users.settings })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const [link] = await database
    .select({ status: moodleConnections.status })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);

  const view = await getAssignmentsView(userId, { now }, database);
  const [head, ...then] = view.open;

  let first: HomeFirst | null = null;
  if (head) {
    const [c] = await database
      .select({ code: courses.code })
      .from(courses)
      .where(eq(courses.id, head.courseId))
      .limit(1);
    first = { ...head, code: c?.code ?? null };
  }

  // `done` is newest first and not limited in time; Home keeps the last 7 days.
  const newest = view.done[0];
  let lastDone: HomeDone | null = null;
  if (newest && now.getTime() - newest.submittedAt.getTime() <= DONE_WINDOW_MS) {
    const [a] = await database
      .select({ dueAt: assignments.dueAt })
      .from(assignments)
      .where(eq(assignments.id, newest.id))
      .limit(1);
    lastDone = { ...newest, dueAt: a?.dueAt ?? null };
  }

  // The Exams tab's list, keeping each `examView` it reads for the bite row and the cards.
  const views = new Map<string, ExamView>();
  const examList = await getExamsView(
    userId,
    {
      now,
      view: async (examId) => {
        const v = await load(examId);
        views.set(examId, v);
        return v;
      },
    },
    database,
  );
  const exams = examList.exams.flatMap((card) => {
    const v = views.get(card.id);
    return v ? [homeExam(card, v)] : [];
  });
  const bite = pickBite(examList.exams, views, now);

  // The greeting: the bite row's exam is the one it offers a bite for.
  const biteView = bite?.state === "bite" ? views.get(bite.examId) : undefined;
  const wholeDay = new Set(examList.exams.filter((e) => e.wholeDay).map((e) => e.id));
  const nextExam: NextExam | null = biteView
    ? { title: biteView.exam.title, at: biteView.exam.at, wholeDay: wholeDay.has(biteView.exam.id) }
    : null;
  const sentence = greeting({
    firstName: firstNameOf(me?.displayName),
    queue: greetingQueue(view.open, now),
    now,
    nextExam,
    ...reactionTo(flash, lastDone, views, wholeDay),
  });

  // The week: due times from a day before now to a day past the window
  // (`weekModel` cuts to Helsinki days). Only rows on the visible lists count.
  const open = new Set(view.open.map((a) => a.id));
  const handedIn = new Set(view.done.map((a) => a.id));
  const dueRows = await database
    .select({ id: assignments.id, title: assignments.name, dueAt: assignments.dueAt })
    .from(assignments)
    .where(
      and(
        eq(assignments.userId, userId),
        gte(assignments.dueAt, new Date(now.getTime() - DAY_MS)),
        lt(assignments.dueAt, new Date(now.getTime() + (WEEK_DAYS + 1) * DAY_MS)),
      ),
    );
  const weekItems: WeekItem[] = [];
  for (const r of dueRows) {
    if (!r.dueAt || !(open.has(r.id) || handedIn.has(r.id))) continue;
    weekItems.push({ id: r.id, kind: "deadline", title: r.title, at: r.dueAt, done: handedIn.has(r.id) });
  }
  for (const card of examList.exams) {
    const v = views.get(card.id);
    if (v) weekItems.push({ id: card.id, kind: card.kind, title: card.title, at: v.exam.at, done: false });
  }

  return {
    firstName: firstNameOf(me?.displayName),
    connection: link ? { status: link.status } : null,
    first,
    then,
    lastDone,
    exams,
    bite,
    biteFirst: first === null && bite?.state === "bite",
    greeting: sentence,
    week: weekModel(weekItems, now),
    grades: (await getGradesList(userId, database)).courses,
    neverMiss: await neverMissFor(userId, me?.settings, now, database),
    pickup: await pickupFor(
      userId,
      examList.exams.map((e) => e.id),
      now,
      database,
    ),
  };
}

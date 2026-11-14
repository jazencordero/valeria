/*
 * Copies the dates on her Moodle calendar, and her quizzes, into `events`,
 * and suggests which of them are exams by adding an `exams` row.
 *
 *   const { added, updated, exams } = await syncEvents(userId);
 *
 * Run it after `syncCourses`: it reads the courses we already store.
 *
 * Where the dates come from:
 * - `getUpcoming`: her course calendar from now to HORIZON_DAYS ahead.
 *   `moodle_ref = event:<Moodle event id>`.
 * - `getQuizzes`: every quiz in her visible courses. The date is when it
 *   closes, or when it opens if it never closes; a quiz with neither has no
 *   date and is skipped. `moodle_ref = quiz:<Moodle quiz id>`.
 *   A quiz's close is also on the calendar. That calendar event is dropped when
 *   a quiz of the same course has the same date, so one quiz is one row.
 * - If her key may not call either function (NotAllowed), that source is an
 *   empty list; the other still syncs. Any other Moodle error is thrown.
 * - Only her visible courses (`courses.hidden = false`). Anything else is skipped.
 *
 * Kind (`kindFor`), first rule that fits:
 *   an assignment                                  'deadline'
 *   the title has an exam word (`isExamTitle`)     'exam'
 *   a quiz                                         'quiz'
 *   anything else                                  'other'
 * So a Moodle quiz called "Midterm exam" is an 'exam'; an assignment called
 * "Final report" stays a 'deadline'.
 *
 * Exam words, matched on whole words, ignoring case:
 * - English: exam, exams, examination(s), midterm(s), mid-term(s), mid term,
 *   final, finals. Not "example", "examine", "finally", "finalize".
 * - Finnish "tentti" in any form: the stem `tentt-`/`tenti-` at the start of a
 *   word (tentti, tentin, tenttiin, tentissä, tenttejä, tentit) and compounds
 *   that contain `tentt` (välitentti, uusintatentti). A compound in a form
 *   with one t (uusintatentissä) is caught only after väli-, uusinta-, loppu-
 *   and kertaus-; matching `tenti` anywhere would catch "attention" and
 *   "potential".
 *
 * Rows:
 * - One `events` row per (user, moodle_ref) with `source = 'moodle'`. The table
 *   has no unique key for this, so the sync looks the row up first (cut: two
 *   syncs at the same moment can both add it, as in ./run).
 * - A row Moodle no longer returns is kept as it is, never deleted: the
 *   calendar only gives dates from now on, so every past date "vanishes", and
 *   her exam (with its cards) may hang off it. A date a teacher removes stays.
 * - A row Moodle still returns is updated when its course, title, date or kind
 *   changed.
 * - A quiz whose date is already past is not added (it would only be a
 *   suggestion for something over). One we already store is still updated.
 *
 * Exams (the suggestion): an `exams` row with `target_pct` 80, the event's
 * title, date and kind, and `event_id` set to the event row. Added exactly once:
 * - when an 'exam' or 'quiz' event row is added, or
 * - when a stored event turns into one (its title now has an exam word) and no
 *   exam links to it.
 * Never otherwise. If she deletes the exam, the event row stays and the next
 * sync does not add it again. When Moodle moves an event, its exam follows only
 * while it still has the event's old date and title, so a date or name she
 * changed herself is kept.
 *
 * Moodle is read in full before anything is written; all writes are one
 * transaction. `added` and `updated` count event rows, `exams` exam rows added.
 */
import { and, eq } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { EVENT_KINDS, events } from "@/server/db/schema/calendar";
import { courses } from "@/server/db/schema/courses";
import { exams } from "@/server/db/schema/study";
import { NotAllowed } from "@/server/moodle/client";
import { getConnection } from "@/server/moodle/connect";
import { getQuizzes, getUpcoming, type CalendarEvent, type Quiz } from "@/server/moodle/read/calendar";
import { NotConnected } from "./courses";

export type EventKind = (typeof EVENT_KINDS)[number];

export type SyncEventsResult = { added: number; updated: number; exams: number };

/** What the sync reads Moodle and the clock with. Tests pass their own. */
export type SyncEventsDeps = {
  getUpcoming: typeof getUpcoming;
  getQuizzes: typeof getQuizzes;
  now: () => number;
};

/** How far ahead the calendar is read. */
export const HORIZON_DAYS = 180;
/** The target a suggested exam starts with. */
export const EXAM_TARGET_PCT = 80;

const DAY_MS = 24 * 60 * 60 * 1000;

const ENGLISH = new Set(["exam", "exams", "examination", "examinations", "midterm", "midterms", "final", "finals"]);
const MID_TERM = /(?:^|[^\p{L}\p{N}])mid[\s-]terms?(?![\p{L}\p{N}])/iu;
const FINNISH = /^(?:tent[ti]|\p{L}*tentt|(?:väli|uusinta|loppu|kertaus)tenti)/u;

/** Whether a title names an exam, in English or Finnish. See the rules in the file header. */
export function isExamTitle(title: string): boolean {
  if (MID_TERM.test(title)) return true;
  for (const word of title.toLocaleLowerCase("fi").match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (ENGLISH.has(word) || FINNISH.test(word)) return true;
  }
  return false;
}

/** The kind of one date. See the table in the file header. */
export function kindFor(module: "assign" | "quiz" | "other", title: string): EventKind {
  if (module === "assign") return "deadline";
  if (isExamTitle(title)) return "exam";
  return module === "quiz" ? "quiz" : "other";
}

const becomesExam = (kind: EventKind): kind is "exam" | "quiz" => kind === "exam" || kind === "quiz";

type Incoming = { moodleRef: string; courseId: string; kind: EventKind; title: string; startsAt: Date };

async function orEmpty<T>(read: Promise<T[]>): Promise<T[]> {
  try {
    return await read;
  } catch (err) {
    if (err instanceof NotAllowed) return [];
    throw err;
  }
}

export async function syncEvents(
  userId: string,
  database: Db = defaultDb,
  deps: SyncEventsDeps = { getUpcoming, getQuizzes, now: () => Date.now() },
): Promise<SyncEventsResult> {
  const conn = await getConnection(userId, database);
  if (!conn) throw new NotConnected();

  const visible = await database
    .select({ id: courses.id, moodleId: courses.moodleId })
    .from(courses)
    .where(and(eq(courses.userId, userId), eq(courses.hidden, false)));
  const courseIdOf = new Map(visible.map((c) => [c.moodleId, c.id]));

  const now = deps.now();
  // Moodle is read before the transaction opens; a failed read changes nothing.
  const quizzes: Quiz[] = await orEmpty(deps.getQuizzes(conn, [...courseIdOf.keys()]));
  const calendar: CalendarEvent[] = await orEmpty(
    deps.getUpcoming(conn, { from: new Date(now), to: new Date(now + HORIZON_DAYS * DAY_MS) }),
  );

  const incoming = new Map<string, Incoming>();
  const quizDates = new Set<string>();
  for (const q of quizzes) {
    const courseId = courseIdOf.get(q.courseMoodleId);
    const startsAt = q.closesAt ?? q.opensAt;
    if (!courseId || !startsAt || incoming.has(q.moodleRef)) continue;
    incoming.set(q.moodleRef, { moodleRef: q.moodleRef, courseId, kind: kindFor("quiz", q.name), title: q.name, startsAt });
    quizDates.add(`${q.courseMoodleId}:${startsAt.getTime()}`);
  }
  for (const e of calendar) {
    const courseId = courseIdOf.get(e.courseMoodleId);
    if (!courseId || incoming.has(e.moodleRef)) continue;
    // The calendar's copy of a quiz we already have from getQuizzes.
    if (e.module === "quiz" && quizDates.has(`${e.courseMoodleId}:${e.startsAt.getTime()}`)) continue;
    incoming.set(e.moodleRef, {
      moodleRef: e.moodleRef,
      courseId,
      kind: kindFor(e.module, e.title),
      title: e.title,
      startsAt: e.startsAt,
    });
  }

  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const existing = await tx
      .select()
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.source, "moodle")));
    const rowOf = new Map(existing.filter((row) => row.moodleRef).map((row) => [row.moodleRef as string, row]));

    let added = 0;
    let updated = 0;
    let examsAdded = 0;
    const suggest = async (eventId: string, e: Incoming & { kind: "exam" | "quiz" }) => {
      await tx.insert(exams).values({
        userId,
        courseId: e.courseId,
        eventId,
        title: e.title,
        kind: e.kind,
        at: e.startsAt,
        targetPct: EXAM_TARGET_PCT,
      });
      examsAdded += 1;
    };

    for (const e of incoming.values()) {
      const row = rowOf.get(e.moodleRef);
      if (!row) {
        if (e.startsAt.getTime() < now) continue;
        const [inserted] = await tx
          .insert(events)
          .values({ userId, source: "moodle", ...e })
          .returning({ id: events.id });
        added += 1;
        if (becomesExam(e.kind)) await suggest(inserted.id, { ...e, kind: e.kind });
        continue;
      }

      const same =
        row.courseId === e.courseId &&
        row.title === e.title &&
        row.kind === e.kind &&
        row.startsAt.getTime() === e.startsAt.getTime();
      if (same) continue;
      await tx
        .update(events)
        .set({ courseId: e.courseId, title: e.title, kind: e.kind, startsAt: e.startsAt })
        .where(eq(events.id, row.id));
      updated += 1;

      // Her exam follows Moodle only where she has not changed it.
      if (row.startsAt.getTime() !== e.startsAt.getTime()) {
        await tx
          .update(exams)
          .set({ at: e.startsAt })
          .where(and(eq(exams.eventId, row.id), eq(exams.at, row.startsAt)));
      }
      if (row.title !== e.title) {
        await tx
          .update(exams)
          .set({ title: e.title })
          .where(and(eq(exams.eventId, row.id), eq(exams.title, row.title)));
      }

      if (becomesExam(e.kind) && !becomesExam(row.kind)) {
        const [linked] = await tx.select({ id: exams.id }).from(exams).where(eq(exams.eventId, row.id)).limit(1);
        if (!linked) await suggest(row.id, { ...e, kind: e.kind });
      }
    }

    return { added, updated, exams: examsAdded };
  });
}

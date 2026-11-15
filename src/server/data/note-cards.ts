/**
 * Note cards, ready to draw (moved out of the Notes tab page for M9-23, so
 * the exam page's Notes tab draws its cards the same way).
 *
 * - `cardDate(at, now)`: "THU 12 NOV", or "TODAY" (Helsinki days).
 * - `lookupsFor(userId, list, names)`: what the attachment pills need for
 *   these notes, read from her own rows only (lecture numbers and titles,
 *   assignment names, exam titles); `names` maps her course ids to their
 *   short names.
 */
import { and, eq, inArray } from "drizzle-orm";
import { sameDay } from "@/lib/dates";
import type { AttachLookups } from "@/lib/notes/attach";
import { db as defaultDb, type Db } from "@/server/db/client";
import { lectures } from "@/server/db/schema/learn";
import { exams } from "@/server/db/schema/study";
import { assignments } from "@/server/db/schema/work";
import type { Note } from "@/server/notes/store";

const DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Helsinki",
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** "THU 12 NOV", or "TODAY". */
export function cardDate(at: Date, now: Date): string {
  if (sameDay(at, now)) return "TODAY";
  const p = Object.fromEntries(DAY.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`.toUpperCase();
}

function idsOf(list: Note[], kind: Note["attach"]["kind"]): string[] {
  return [...new Set(list.filter((n) => n.attach.kind === kind && n.attach.id).map((n) => n.attach.id as string))];
}

export async function lookupsFor(
  userId: string,
  list: Note[],
  names: Record<string, string>,
  database: Db = defaultDb,
): Promise<AttachLookups> {
  const lectureIds = idsOf(list, "lecture");
  const assignmentIds = idsOf(list, "assignment");
  const examIds = idsOf(list, "exam");
  const [ls, as, es] = await Promise.all([
    lectureIds.length
      ? database
          .select({ id: lectures.id, n: lectures.n, title: lectures.title })
          .from(lectures)
          .where(and(eq(lectures.userId, userId), inArray(lectures.id, lectureIds)))
      : [],
    assignmentIds.length
      ? database
          .select({ id: assignments.id, name: assignments.name })
          .from(assignments)
          .where(and(eq(assignments.userId, userId), inArray(assignments.id, assignmentIds)))
      : [],
    examIds.length
      ? database
          .select({ id: exams.id, kind: exams.kind, title: exams.title, courseId: exams.courseId })
          .from(exams)
          .where(and(eq(exams.userId, userId), inArray(exams.id, examIds)))
      : [],
  ]);
  return {
    courses: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { name }])),
    lectures: Object.fromEntries(ls.map((l) => [l.id, { n: l.n, title: l.title }])),
    assignments: Object.fromEntries(as.map((a) => [a.id, { name: a.name }])),
    exams: Object.fromEntries(
      es.map((e) => [e.id, { kind: e.kind, title: e.title, courseName: names[e.courseId] ?? "" }]),
    ),
  };
}

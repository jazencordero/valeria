/**
 * The exam page's Lectures and Notes tabs (M9-23), ready to draw.
 * Source: prototype merged-2.html JS 6014-6022 (examLecs, examNotes),
 * 6049-6062 (lecturesHTML) and 6081-6096 (notesTabHTML, renderExamNotes).
 *
 *   const tabs = await getExamTabs(userId, { examId, courseId, courseName, now });
 *
 * Reads our database only, her rows only: every query is filtered by
 * `userId`, which the caller takes from the session.
 *
 * Choices:
 * - Lectures are the course's lectures this exam's concepts come from: the
 *   number in a concept's `lecture` text ("Lecture 3", as the prototype's
 *   `examLecs`) or a `lecture_concepts` link, in lecture order. An exam with
 *   no concept tied to a lecture (cards still being made) lists every
 *   lecture of the course instead, so the tab is never empty while the
 *   course has lectures.
 * - A row's concepts: the names of this exam's concepts tied to it, in the
 *   exam's order, joined with ", ".
 * - States come from the course path (M9-03's `courseView`): read, current,
 *   not read yet, not posted. "Continue lecture N" is the course's current
 *   lecture (none when every lecture is read or none has opened).
 * - Minutes are the lecture page's reading time (`lecture_content.minutes`),
 *   null until the page is written.
 * - Notes: every note of the course, plus notes attached to this exam (as
 *   the prototype's `examNotes`: `att.course === k || att.exam === key`; a
 *   stored note attached to the exam carries its course too), newest first.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { ExamLectureRow, ExamLectures } from "@/components/exams/exam-lectures";
import type { NoteCardData } from "@/components/notes/note-card";
import { attachLabel } from "@/lib/notes/attach";
import { courseView } from "@/server/courses/store";
import { dayText } from "@/server/data/courses";
import { lectureHref } from "@/server/data/lecture";
import { cardDate, lookupsFor } from "@/server/data/note-cards";
import { db as defaultDb, type Db } from "@/server/db/client";
import { lectureConcepts, lectureContent, lectures } from "@/server/db/schema/learn";
import { concepts } from "@/server/db/schema/study";
import { listNotes } from "@/server/notes/store";

export type ExamTabs = { lectures: ExamLectures; notes: NoteCardData[] };

const lectureNumber = (text: string | null): number | null => {
  const n = Number(text?.match(/\d+/)?.[0]);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function getExamTabs(
  userId: string,
  options: { examId: string; courseId: string; courseName: string; now: Date },
  database: Db = defaultDb,
): Promise<ExamTabs> {
  const { examId, courseId, courseName, now } = options;

  const [view, examConcepts, noteList] = await Promise.all([
    courseView(userId, courseId, database, now),
    database
      .select({ id: concepts.id, name: concepts.name, lecture: concepts.lecture })
      .from(concepts)
      .where(and(eq(concepts.userId, userId), eq(concepts.examId, examId)))
      .orderBy(asc(concepts.position), asc(concepts.createdAt)),
    listNotes(userId, { courseId }, database),
  ]);

  // ---- Lectures
  const lectureIds = view.lectures.map((l) => l.id);
  const conceptIds = examConcepts.map((c) => c.id);
  const [links, contents] = await Promise.all([
    lectureIds.length && conceptIds.length
      ? database
          .select({ lectureId: lectureConcepts.lectureId, conceptId: lectureConcepts.conceptId })
          .from(lectureConcepts)
          .innerJoin(concepts, eq(concepts.id, lectureConcepts.conceptId))
          .where(
            and(
              eq(concepts.userId, userId),
              inArray(lectureConcepts.lectureId, lectureIds),
              inArray(lectureConcepts.conceptId, conceptIds),
            ),
          )
      : [],
    lectureIds.length
      ? database
          .select({ lectureId: lectureContent.lectureId, minutes: lectureContent.minutes })
          .from(lectureContent)
          .innerJoin(lectures, eq(lectures.id, lectureContent.lectureId))
          .where(and(eq(lectures.userId, userId), inArray(lectureContent.lectureId, lectureIds)))
      : [],
  ]);

  const idOfN = new Map(view.lectures.map((l) => [l.n, l.id]));
  const tied = new Map<string, Set<string>>(); // lecture id -> concept ids
  const tie = (lectureId: string | undefined, conceptId: string) => {
    if (!lectureId) return;
    const set = tied.get(lectureId) ?? new Set<string>();
    set.add(conceptId);
    tied.set(lectureId, set);
  };
  for (const c of examConcepts) {
    const n = lectureNumber(c.lecture);
    if (n !== null) tie(idOfN.get(n), c.id);
  }
  for (const l of links) tie(l.lectureId, l.conceptId);

  const minutesOf = new Map(contents.map((c) => [c.lectureId, c.minutes]));
  const shown = tied.size > 0 ? view.lectures.filter((l) => tied.has(l.id)) : view.lectures;
  const rows: ExamLectureRow[] = shown.map((l) => {
    const ids = tied.get(l.id);
    return {
      n: l.n,
      title: l.title,
      concepts: ids ? examConcepts.filter((c) => ids.has(c.id)).map((c) => c.name).join(", ") : "",
      minutes: minutesOf.get(l.id) ?? null,
      state: l.state,
      opensOn: l.state === "soon" && l.opensAt ? dayText(l.opensAt) : null,
      href: lectureHref(courseId, l.n),
    };
  });
  const cur = view.lectures.find((l) => l.state === "cur");

  // ---- Notes
  const lookups = await lookupsFor(userId, noteList, { [courseId]: courseName }, database);
  const notes: NoteCardData[] = noteList.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    quote: n.quote,
    highlighted: n.highlighted,
    attachLabel: attachLabel(n, lookups),
    date: cardDate(n.updatedAt, now),
  }));

  return {
    lectures: { courseId, current: cur ? { n: cur.n, href: lectureHref(courseId, cur.n) } : null, rows },
    notes,
  };
}

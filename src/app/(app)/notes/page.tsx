/**
 * Notes tab (M9-14): everything she wrote, by course.
 * Source: prototype merged.html HTML 1878-1887 (#tab-notes), CSS 1090-1105
 * and JS 5684-5721.
 *
 * The heading ships in the static shell; her notes depend on the cookie and
 * on `?q=` (search) and `?course=` (a course id, or `general`), so they
 * stream inside Suspense. The server filters (`listNotes`, M9-11), so a
 * search plus a course can be shared as a link.
 *
 * The attachment pill reads her own rows only (course short names, lecture
 * numbers and titles, assignment names, exam titles) for the notes shown.
 * Cut: no folders, tags or export.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { connection } from "next/server";
import { Suspense } from "react";
import { DoodleDefs } from "@/components/doodle";
import type { NoteCardData } from "@/components/notes/note-card";
import { GENERAL_FILTER, NotesGrid } from "@/components/notes/notes-grid";
import { sameDay } from "@/lib/dates";
import { attachLabel, type AttachLookups } from "@/lib/notes/attach";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { shortNameOf } from "@/server/data/courses";
import { db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { lectures } from "@/server/db/schema/learn";
import { exams } from "@/server/db/schema/study";
import { assignments } from "@/server/db/schema/work";
import { listNotes, type Note } from "@/server/notes/store";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

const DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Helsinki",
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** "THU 12 NOV", or "TODAY". */
function cardDate(at: Date, now: Date): string {
  if (sameDay(at, now)) return "TODAY";
  const p = Object.fromEntries(DAY.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`.toUpperCase();
}

function idsOf(list: Note[], kind: Note["attach"]["kind"]): string[] {
  return [...new Set(list.filter((n) => n.attach.kind === kind && n.attach.id).map((n) => n.attach.id as string))];
}

async function lookupsFor(userId: string, list: Note[], names: Record<string, string>): Promise<AttachLookups> {
  const lectureIds = idsOf(list, "lecture");
  const assignmentIds = idsOf(list, "assignment");
  const examIds = idsOf(list, "exam");
  const [ls, as, es] = await Promise.all([
    lectureIds.length
      ? db
          .select({ id: lectures.id, n: lectures.n, title: lectures.title })
          .from(lectures)
          .where(and(eq(lectures.userId, userId), inArray(lectures.id, lectureIds)))
      : [],
    assignmentIds.length
      ? db
          .select({ id: assignments.id, name: assignments.name })
          .from(assignments)
          .where(and(eq(assignments.userId, userId), inArray(assignments.id, assignmentIds)))
      : [],
    examIds.length
      ? db
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

async function NotesBody({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  await connection();
  const user = await signedInUser();
  const now = new Date();
  const query = typeof params.q === "string" ? params.q : "";
  const course = typeof params.course === "string" && params.course ? params.course : null;

  const [mine, list] = await Promise.all([
    db
      .select({ id: courses.id, name: courses.name, hidden: courses.hidden })
      .from(courses)
      .where(eq(courses.userId, user.id))
      .orderBy(asc(courses.name)),
    listNotes(user.id, { courseId: course === GENERAL_FILTER ? "general" : course, query }),
  ]);
  const names = Object.fromEntries(mine.map((c) => [c.id, shortNameOf(c.name)]));
  const lookups = await lookupsFor(user.id, list, names);

  const cards: NoteCardData[] = list.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    quote: n.quote,
    highlighted: n.highlighted,
    attachLabel: attachLabel(n, lookups),
    date: cardDate(n.updatedAt, now),
  }));

  return (
    <NotesGrid
      notes={cards}
      courses={mine.filter((c) => !c.hidden).map((c) => ({ id: c.id, name: names[c.id] }))}
      query={query}
      course={course}
    />
  );
}

export default function NotesPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="mx-auto max-w-[1040px] px-[var(--pad)] pt-[max(20px,env(safe-area-inset-top,0px))] pb-10">
      <DoodleDefs />
      <h1 className="type-h30" tabIndex={-1}>
        Notes
      </h1>
      <p className="mt-1.5 text-[15px] text-ink-2">Everything you wrote, by course.</p>
      <Suspense fallback={null}>
        <NotesBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

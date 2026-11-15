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
import { asc, eq } from "drizzle-orm";
import { connection } from "next/server";
import { Suspense } from "react";
import { DoodleDefs } from "@/components/doodle";
import type { NoteCardData } from "@/components/notes/note-card";
import { GENERAL_FILTER, NotesGrid } from "@/components/notes/notes-grid";
import { attachLabel } from "@/lib/notes/attach";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { shortNameOf } from "@/server/data/courses";
import { cardDate, lookupsFor } from "@/server/data/note-cards";
import { db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { listNotes } from "@/server/notes/store";

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

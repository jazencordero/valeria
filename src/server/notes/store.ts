/**
 * Notes storage and search (ticket M9-11).
 *
 * Every function takes the signed-in `userId` and only reads or writes that
 * user's notes; another user's note looks exactly like one that does not
 * exist. Like the other server modules, the database handle is the last
 * argument and defaults to the app's `db`; `saveNote` takes `now`.
 *
 * Choices:
 * - A note is `{ title, body, quote, highlighted, attach: { kind, id } }`.
 *   `attach.id` is the course, lecture, assignment or exam id (null for
 *   general). The row also keeps `course_id` for every kind but general (the
 *   lecture's, assignment's or exam's course), so the course filter finds a
 *   course's notes from its lectures, assignments and exams too, and a note
 *   whose lecture was deleted still shows under its course.
 * - Empty means title and body are both blank after trimming (a quote alone
 *   does not count: the highlight is stored on its own). Creating an empty
 *   note stores nothing and returns null. Saving an existing note as empty
 *   deletes it and returns null (as if it had never been written); the
 *   caller must then forget the id, and its next save creates a new note.
 * - On update, fields left out keep their value, including `attach`. A blank
 *   title is stored as null. Body and quote are stored as typed.
 * - Saving with an id that is not hers, or attaching to a course, lecture,
 *   assignment or exam that is not hers, throws `NoteNotFound`.
 * - Newest first means most recently saved first (`updated_at`), then
 *   creation time, then id, so the order is stable.
 * - `listNotes` filter: `courseId` a course id -> notes with that course;
 *   'general' -> notes with no course (general ones, and ones whose course
 *   was deleted); null or left out -> all. `query` is trimmed; blank means
 *   no search. Search is a case-insensitive substring match (ILIKE, works in
 *   PGlite and Neon) over title, body and quote, with `\`, `%` and `_`
 *   escaped so they match themselves.
 * - `getNote` returns null when the note is not hers; `deleteNote` returns
 *   whether it deleted anything (deleting twice is harmless).
 */
import { and, count, desc, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { lectures, notes } from "@/server/db/schema/learn";
import { exams } from "@/server/db/schema/study";
import { assignments } from "@/server/db/schema/work";
import type { NoteAttach, NoteAttachKind } from "@/lib/notes/attach";

export class NoteNotFound extends Error {
  constructor(what: "note" | NoteAttachKind, id: string) {
    super(`No ${what} ${id} for this user.`);
    this.name = "NoteNotFound";
  }
}

export type Note = {
  id: string;
  title: string | null;
  body: string;
  quote: string | null;
  highlighted: boolean;
  attach: NoteAttach;
  /** The course the note belongs to (through what it is attached to), or null. */
  courseId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NoteInput = {
  /** Present to update that note; left out to create one. */
  id?: string;
  title?: string | null;
  body?: string;
  quote?: string | null;
  highlighted?: boolean;
  /** Defaults to general on create; left out on update keeps the old one. */
  attach?: { kind: NoteAttachKind; id?: string | null };
};

export type NoteFilter = {
  courseId?: string | "general" | null;
  query?: string;
};

type Row = typeof notes.$inferSelect;

function toNote(r: Row): Note {
  const id =
    r.attachKind === "course"
      ? r.courseId
      : r.attachKind === "lecture"
        ? r.lectureId
        : r.attachKind === "assignment"
          ? r.assignmentId
          : r.attachKind === "exam"
            ? r.examId
            : null;
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    quote: r.quote,
    highlighted: r.highlighted,
    attach: { kind: r.attachKind, id },
    courseId: r.courseId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(id: string): boolean {
  return UUID.test(id);
}

const NEWEST_FIRST = [desc(notes.updatedAt), desc(notes.createdAt), desc(notes.id)];

/** `\`, `%` and `_` match themselves; the default ILIKE escape is backslash. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function blank(s: string | null | undefined): boolean {
  return (s ?? "").trim() === "";
}

type Links = {
  attachKind: NoteAttachKind;
  courseId: string | null;
  lectureId: string | null;
  assignmentId: string | null;
  examId: string | null;
};

/** The columns for an attachment, after checking the thing is hers. */
async function resolveAttach(
  database: Db,
  userId: string,
  attach: { kind: NoteAttachKind; id?: string | null },
): Promise<Links> {
  const links: Links = { attachKind: attach.kind, courseId: null, lectureId: null, assignmentId: null, examId: null };
  if (attach.kind === "general") return links;
  const id = attach.id ?? "";
  if (!isUuid(id)) throw new NoteNotFound(attach.kind, id);
  let found: { courseId: string } | undefined;
  switch (attach.kind) {
    case "course":
      [found] = await database
        .select({ courseId: courses.id })
        .from(courses)
        .where(and(eq(courses.id, id), eq(courses.userId, userId)));
      break;
    case "lecture":
      [found] = await database
        .select({ courseId: lectures.courseId })
        .from(lectures)
        .where(and(eq(lectures.id, id), eq(lectures.userId, userId)));
      if (found) links.lectureId = id;
      break;
    case "assignment":
      [found] = await database
        .select({ courseId: assignments.courseId })
        .from(assignments)
        .where(and(eq(assignments.id, id), eq(assignments.userId, userId)));
      if (found) links.assignmentId = id;
      break;
    case "exam":
      [found] = await database
        .select({ courseId: exams.courseId })
        .from(exams)
        .where(and(eq(exams.id, id), eq(exams.userId, userId)));
      if (found) links.examId = id;
      break;
  }
  if (!found) throw new NoteNotFound(attach.kind, id);
  links.courseId = found.courseId;
  return links;
}

export async function listNotes(
  userId: string,
  filter: NoteFilter = {},
  database: Db = defaultDb,
): Promise<Note[]> {
  const where: (SQL | undefined)[] = [eq(notes.userId, userId)];
  const { courseId } = filter;
  if (courseId === "general") where.push(isNull(notes.courseId));
  else if (courseId != null) {
    if (!isUuid(courseId)) return [];
    where.push(eq(notes.courseId, courseId));
  }
  const query = filter.query?.trim() ?? "";
  if (query !== "") {
    const p = likePattern(query);
    where.push(or(ilike(notes.title, p), ilike(notes.body, p), ilike(notes.quote, p)));
  }
  const rows = await database
    .select()
    .from(notes)
    .where(and(...where))
    .orderBy(...NEWEST_FIRST);
  return rows.map(toNote);
}

export async function getNote(userId: string, noteId: string, database: Db = defaultDb): Promise<Note | null> {
  if (!isUuid(noteId)) return null;
  const [row] = await database
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)));
  return row ? toNote(row) : null;
}

/** Creates or updates; returns the stored note, or null when it is empty (see the header). */
export async function saveNote(
  userId: string,
  note: NoteInput,
  now: Date = new Date(),
  database: Db = defaultDb,
): Promise<Note | null> {
  if (note.id === undefined) {
    if (blank(note.title) && blank(note.body)) return null;
    const links = await resolveAttach(database, userId, note.attach ?? { kind: "general" });
    const [row] = await database
      .insert(notes)
      .values({
        userId,
        title: blank(note.title) ? null : note.title,
        body: note.body ?? "",
        quote: note.quote ?? null,
        highlighted: note.highlighted ?? false,
        ...links,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toNote(row);
  }

  const existing = await getNote(userId, note.id, database);
  if (!existing) throw new NoteNotFound("note", note.id);
  const title = note.title !== undefined ? note.title : existing.title;
  const body = note.body ?? existing.body;
  if (blank(title) && blank(body)) {
    await deleteNote(userId, note.id, database);
    return null;
  }
  const links = note.attach ? await resolveAttach(database, userId, note.attach) : {};
  const [row] = await database
    .update(notes)
    .set({
      title: blank(title) ? null : title,
      body,
      quote: note.quote !== undefined ? note.quote : existing.quote,
      highlighted: note.highlighted ?? existing.highlighted,
      ...links,
      updatedAt: now,
    })
    .where(and(eq(notes.id, note.id), eq(notes.userId, userId)))
    .returning();
  if (!row) throw new NoteNotFound("note", note.id);
  return toNote(row);
}

export async function deleteNote(userId: string, noteId: string, database: Db = defaultDb): Promise<boolean> {
  if (!isUuid(noteId)) return false;
  const gone = await database
    .delete(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
    .returning({ id: notes.id });
  return gone.length > 0;
}

/** Her notes attached to one lecture, newest first. */
export async function notesForLecture(userId: string, lectureId: string, database: Db = defaultDb): Promise<Note[]> {
  if (!isUuid(lectureId)) return [];
  const rows = await database
    .select()
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.lectureId, lectureId)))
    .orderBy(...NEWEST_FIRST);
  return rows.map(toNote);
}

export async function countNotes(userId: string, database: Db = defaultDb): Promise<number> {
  const [row] = await database.select({ n: count() }).from(notes).where(eq(notes.userId, userId));
  return row?.n ?? 0;
}

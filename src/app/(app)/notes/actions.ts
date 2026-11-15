"use server";

/**
 * M9-13: the notepad's two Server Actions.
 *
 * - `notepadContext(path)`: the chip text for a new note made on that page
 *   ("General", the assignment's name, "Lecture 5 · ...", ...). The page is
 *   read with `attachFromPath` and the name comes from her own rows only; a
 *   page whose thing is not hers (or gone) reads as "General".
 * - `saveNotepad(input)`: one debounced save from the drawer. Without `id` it
 *   creates a note attached to `path` (a lecture page's course + number is
 *   resolved to the lecture id here); with `id` it updates that note and
 *   leaves its attachment alone. An empty note stores nothing, and saving an
 *   existing note as empty deletes it (`saveNote`, M9-11): either way the
 *   answer is `id: null`. When the page's thing is not hers the note is saved
 *   as general rather than lost.
 *
 * - `removeNote(id)` (M9-14): deletes one of her notes, from the Notes tab's
 *   card menu. A note that is not hers (or already gone) answers not_found.
 *
 * Creating or deleting a note changes the sidebar's Notes count, so those two
 * call `refresh()` (the app layout re-reads `countNotes`). A plain edit does
 * not, so typing never re-renders the page.
 *
 * Who she is comes from the session cookie. Every export of a "use server"
 * file is a public endpoint, so nothing exported takes a user id; the inputs
 * are checked with zod before use.
 */
import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { attachFromPath, attachLabel, GENERAL, type AttachLookups } from "@/lib/notes/attach";
import type { NoteAttachKind } from "@/lib/notes/attach";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { lectures } from "@/server/db/schema/learn";
import { exams } from "@/server/db/schema/study";
import { assignments } from "@/server/db/schema/work";
import { deleteNote, NoteNotFound, saveNote } from "@/server/notes/store";

export type NotepadFailure = { ok: false; reason: "invalid" | "not_found" | "signed_out" };

export type NotepadContextResult = { ok: true; label: string } | NotepadFailure;

/** `id` is the stored note, or null when nothing is stored (empty, or emptied and deleted). */
export type NotepadSaveResult = { ok: true; id: string | null } | NotepadFailure;

export type NoteRemoveResult = { ok: true } | NotepadFailure;

const Path = z.string().max(500);

const SaveInput = z.object({
  id: z.uuid().optional(),
  path: Path.optional(),
  title: z.string().max(300),
  body: z.string().max(20_000),
  quote: z.string().max(4_000).nullable().optional(),
  highlighted: z.boolean(),
});

async function userIdOrNull(): Promise<string | null> {
  try {
    return (await currentUser()).id;
  } catch (err) {
    if (err instanceof NotSignedIn) return null;
    throw err;
  }
}

type Attach = { kind: NoteAttachKind; id?: string | null };

/** What a new note on `path` attaches to, as `saveNote` takes it. Lectures resolve to their id. */
async function attachOf(userId: string, path: string): Promise<Attach> {
  const at = attachFromPath(path);
  if (at.kind === "general") return { kind: "general" };
  if (at.kind !== "lecture") return { kind: at.kind, id: at.id };
  const [row] = await db
    .select({ id: lectures.id })
    .from(lectures)
    .where(and(eq(lectures.userId, userId), eq(lectures.courseId, at.courseId), eq(lectures.n, at.n)));
  return row ? { kind: "lecture", id: row.id } : { kind: "course", id: at.courseId };
}

/** The chip text for `attach`, from her own rows. */
async function labelOf(userId: string, attach: Attach): Promise<string> {
  const id = attach.id ?? null;
  if (attach.kind === "general" || id === null) return GENERAL;
  const lookups: AttachLookups = {};
  switch (attach.kind) {
    case "course": {
      const [c] = await db
        .select({ name: courses.name })
        .from(courses)
        .where(and(eq(courses.id, id), eq(courses.userId, userId)));
      if (c) lookups.courses = { [id]: c };
      break;
    }
    case "lecture": {
      const [l] = await db
        .select({ n: lectures.n, title: lectures.title })
        .from(lectures)
        .where(and(eq(lectures.id, id), eq(lectures.userId, userId)));
      if (l) lookups.lectures = { [id]: l };
      break;
    }
    case "assignment": {
      const [a] = await db
        .select({ name: assignments.name })
        .from(assignments)
        .where(and(eq(assignments.id, id), eq(assignments.userId, userId)));
      if (a) lookups.assignments = { [id]: a };
      break;
    }
    case "exam": {
      const [e] = await db
        .select({ kind: exams.kind, title: exams.title, courseName: courses.name })
        .from(exams)
        .innerJoin(courses, eq(courses.id, exams.courseId))
        .where(and(eq(exams.id, id), eq(exams.userId, userId)));
      if (e) lookups.exams = { [id]: e };
      break;
    }
  }
  return attachLabel({ attach: { kind: attach.kind, id } }, lookups);
}

export async function notepadContext(path: unknown): Promise<NotepadContextResult> {
  const parsed = Path.safeParse(path);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const userId = await userIdOrNull();
  if (!userId) return { ok: false, reason: "signed_out" };
  const label = await labelOf(userId, await attachOf(userId, parsed.data));
  return { ok: true, label };
}

export async function saveNotepad(input: unknown): Promise<NotepadSaveResult> {
  const parsed = SaveInput.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { id, path, title, body, quote, highlighted } = parsed.data;
  const userId = await userIdOrNull();
  if (!userId) return { ok: false, reason: "signed_out" };

  if (id !== undefined) {
    try {
      const saved = await saveNote(userId, { id, title, body, quote, highlighted });
      if (!saved) refresh();
      return { ok: true, id: saved?.id ?? null };
    } catch (err) {
      if (err instanceof NoteNotFound) return { ok: false, reason: "not_found" };
      throw err;
    }
  }

  const fields = { title, body, quote: quote ?? null, highlighted };
  let saved;
  try {
    saved = await saveNote(userId, { ...fields, attach: await attachOf(userId, path ?? "") });
  } catch (err) {
    if (!(err instanceof NoteNotFound)) throw err;
    // The page's course, lecture, assignment or exam is not hers: keep the words anyway.
    saved = await saveNote(userId, { ...fields, attach: { kind: "general" } });
  }
  if (saved) refresh();
  return { ok: true, id: saved?.id ?? null };
}

export async function removeNote(id: unknown): Promise<NoteRemoveResult> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const userId = await userIdOrNull();
  if (!userId) return { ok: false, reason: "signed_out" };
  if (!(await deleteNote(userId, parsed.data))) return { ok: false, reason: "not_found" };
  refresh();
  return { ok: true };
}

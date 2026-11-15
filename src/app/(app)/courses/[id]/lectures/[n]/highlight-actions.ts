"use server";

/**
 * M9-16: the butter highlights on a lecture's text. The lecture page reads
 * them when it opens (`lectureHighlights`) and stores one when she presses
 * "Add note" on a selection (`saveHighlight`). The page re-applies them by
 * matching the text (src/components/lecture/select-note.tsx).
 *
 * - Who she is comes from the session cookie; the browser sends only the
 *   lecture id and the text, both checked before use. Another user's lecture
 *   reads as "not_found", the same as one that does not exist.
 * - The text is whitespace-collapsed and trimmed, at least 3 characters (the
 *   page offers "Add note" only past two) and capped at `HIGHLIGHT_MAX`
 *   characters, the notepad's quote limit. The same text on the same lecture
 *   is stored once.
 *
 * Every export of a "use server" file is a public endpoint, so this file
 * exports only the actions.
 *
 * Cut: no removing a highlight.
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { highlights, lectures } from "@/server/db/schema/learn";

export type HighlightSaveResult = { ok: true; text: string } | { ok: false; reason: "invalid" | "not_found" | "signed_out" };
export type HighlightListResult = { ok: true; texts: string[] } | { ok: false; reason: "invalid" | "not_found" | "signed_out" };

const LectureId = z.uuid();
const Text = z
  .string()
  .max(20_000)
  .transform((s) => s.replace(/\s+/g, " ").trim())
  .pipe(z.string().min(3).max(4_000));

async function userIdOrNull(): Promise<string | null> {
  try {
    return (await currentUser()).id;
  } catch (err) {
    if (err instanceof NotSignedIn) return null;
    throw err;
  }
}

async function ownsLecture(userId: string, lectureId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: lectures.id })
    .from(lectures)
    .where(and(eq(lectures.id, lectureId), eq(lectures.userId, userId)));
  return !!row;
}

export async function saveHighlight(lectureId: unknown, text: unknown): Promise<HighlightSaveResult> {
  const id = LectureId.safeParse(lectureId);
  const t = Text.safeParse(text);
  if (!id.success || !t.success) return { ok: false, reason: "invalid" };

  const userId = await userIdOrNull();
  if (!userId) return { ok: false, reason: "signed_out" };
  if (!(await ownsLecture(userId, id.data))) return { ok: false, reason: "not_found" };

  const [dupe] = await db
    .select({ id: highlights.id })
    .from(highlights)
    .where(and(eq(highlights.userId, userId), eq(highlights.lectureId, id.data), eq(highlights.text, t.data)));
  if (!dupe) await db.insert(highlights).values({ userId, lectureId: id.data, text: t.data });
  return { ok: true, text: t.data };
}

export async function lectureHighlights(lectureId: unknown): Promise<HighlightListResult> {
  const id = LectureId.safeParse(lectureId);
  if (!id.success) return { ok: false, reason: "invalid" };

  const userId = await userIdOrNull();
  if (!userId) return { ok: false, reason: "signed_out" };
  if (!(await ownsLecture(userId, id.data))) return { ok: false, reason: "not_found" };

  const rows = await db
    .select({ text: highlights.text })
    .from(highlights)
    .where(and(eq(highlights.userId, userId), eq(highlights.lectureId, id.data)))
    .orderBy(asc(highlights.createdAt));
  return { ok: true, texts: rows.map((r) => r.text) };
}

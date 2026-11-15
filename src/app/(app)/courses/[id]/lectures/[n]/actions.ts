"use server";

/**
 * M9-10: "READ · MARKED ON YOUR PATH". The lecture page calls this once when
 * she has read it (see src/components/lecture/use-read-progress.ts).
 *
 * It marks the lecture read with M9-03's `markRead` and answers with the
 * course's new state: which stop is current now, and whether marking moved it
 * (`advanced`), so the path can play its advance when she goes back. The
 * course page is revalidated so going back shows the new state.
 *
 * - Who she is comes from the session cookie; the browser sends only the
 *   lecture id, checked before use. Another user's lecture reads as
 *   "not_found", the same as one that does not exist.
 * - The current stop is the lecture `courseView` marks "cur" (the first posted
 *   lecture she has not read), by its number `n`; null when none is (every
 *   posted lecture read).
 * - `advanced` compares the current stop before and after the mark. Marking a
 *   lecture that is already read changes nothing (`markRead` keeps the first
 *   time), so a second call answers `advanced: null`. Reading a later lecture
 *   than the current one does not move the current stop either.
 *
 * Every export of a "use server" file is a public endpoint, so this file
 * exports only the action: no helper that takes a user id or a database.
 *
 * Cut: no "mark unread".
 */
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { CourseNotFound, courseView, markRead, type CourseView } from "@/server/courses/store";
import { db } from "@/server/db/client";
import { lectures } from "@/server/db/schema/learn";

export type CurrentStop = { lectureId: string; n: number } | null;

export type MarkReadResult =
  | {
      ok: true;
      courseId: string;
      lectureId: string;
      readAt: Date;
      /** The current stop after marking. */
      current: CurrentStop;
      /** The current stop moved: from lecture `from` to lecture `to` (null: no current stop left). */
      advanced: { from: number; to: number | null } | null;
    }
  | { ok: false; reason: "invalid" | "not_found" | "signed_out" };

const LectureId = z.uuid();

function currentOf(view: CourseView): CurrentStop {
  const cur = view.lectures.find((l) => l.state === "cur");
  return cur ? { lectureId: cur.id, n: cur.n } : null;
}

export async function markLectureRead(lectureId: unknown): Promise<MarkReadResult> {
  const parsed = LectureId.safeParse(lectureId);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const id = parsed.data;

  let userId: string;
  try {
    userId = (await currentUser()).id;
  } catch (err) {
    if (err instanceof NotSignedIn) return { ok: false, reason: "signed_out" };
    throw err;
  }

  const [row] = await db
    .select({ courseId: lectures.courseId })
    .from(lectures)
    .where(and(eq(lectures.id, id), eq(lectures.userId, userId)));
  if (!row) return { ok: false, reason: "not_found" };

  try {
    const now = new Date();
    const before = currentOf(await courseView(userId, row.courseId, db, now));
    const mark = await markRead(userId, id, db, now);
    const current = currentOf(await courseView(userId, row.courseId, db, now));
    const advanced =
      before !== null && before.lectureId !== current?.lectureId ? { from: before.n, to: current?.n ?? null } : null;
    revalidatePath(`/courses/${row.courseId}`);
    return { ok: true, courseId: row.courseId, lectureId: id, readAt: mark.readAt, current, advanced };
  } catch (err) {
    if (err instanceof CourseNotFound) return { ok: false, reason: "not_found" };
    throw err;
  }
}

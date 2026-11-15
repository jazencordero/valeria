/*
 * Weights form action (M6-04): she types how much each piece of a course
 * counts, and adds the pieces the LMS does not list yet (often the exam).
 *
 * Same shape as exams/actions.ts (M3-13) and settings/actions.ts (M1-38): the
 * work sits in `saveWeightsFor`, a plain function that takes a `Db` and a user
 * id, and `saveWeightsAction` is a thin Server Action that finds the signed-in
 * user first. No file-level "use server" on purpose: that would make
 * `saveWeightsFor`, which takes any user id, a callable endpoint. A server page
 * passes `saveWeightsAction` to `WeightsForm` (or `NeedsWeightsCard`) as a prop.
 *
 * Rules:
 * - Percents are 0 to 100 with at most one decimal (12.5). They are summed in
 *   tenths, so the total is exact: it must be exactly 100.0, no slack.
 * - Stored as fractions (20 % is 0.2), as M6-02 stores Moodle's weights, with
 *   `weight_source 'manual'`, which `syncGrades` never overwrites.
 * - Every grade item the course has must be in the rows, once. If the list
 *   changed since she opened the form (a sync added a piece), nothing is saved
 *   and she is asked to open it again, so no item is left without a weight.
 * - An added piece becomes a grade item with `moodle_ref 'manual:<uuid>'`
 *   (the column is required and unique per user; `syncGrades` only ever looks
 *   up `gradeitem:<id>` refs, so it never touches these), `max` 100 (her score
 *   on it will be a percent), no score, placed after the course's other items.
 * - The course and every item must be hers; otherwise nothing is saved.
 * - All writes are one transaction.
 */
import { randomUUID } from "node:crypto";
import { and, eq, max } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { SaveWeightsResult, WeightRow } from "@/components/grades/weights-form";
import { currentUser, NotSignedIn, type User } from "@/server/auth/session";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { gradeItems } from "@/server/db/schema/grades";
import { shortLabel } from "@/server/sync/grades";

/** Longest name for an added piece (the form says the same). */
const PIECE_NAME_MAX = 120;

/** A percent as a whole number of tenths (12.5 % is 125), or null when it has more than one decimal. */
function tenthsOf(percent: number): number | null {
  const tenths = Math.round(percent * 10);
  return Math.abs(tenths - percent * 10) < 1e-6 ? tenths : null;
}

const Percent = z
  .number()
  .min(0)
  .max(100)
  .refine((p) => tenthsOf(p) !== null, "At most one decimal.");

const Row = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item"), id: z.uuid(), percent: Percent }),
  z.object({ kind: z.literal("new"), name: z.string().trim().min(1).max(PIECE_NAME_MAX), percent: Percent }),
]);

const Input = z.object({
  courseId: z.uuid(),
  rows: z.array(Row).min(1).max(200),
});

const MSG = {
  invalid: "Check the numbers and try again.",
  notHers: "That course is not in your list any more.",
  changed: "The pieces of this course changed since you opened this. Close it and open it again.",
} as const;

const fmtPercent = (tenths: number) => (tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1));

/**
 * Saves her weights for one course and creates the pieces she added. Never
 * throws for her mistakes or for ids that are not hers; returns why instead.
 */
export async function saveWeightsFor(
  database: Db,
  userId: string,
  courseId: string,
  rows: readonly WeightRow[],
): Promise<SaveWeightsResult> {
  const parsed = Input.safeParse({ courseId, rows });
  if (!parsed.success) return { ok: false, message: MSG.invalid };
  const input = parsed.data;

  const total = input.rows.reduce((sum, r) => sum + (tenthsOf(r.percent) ?? 0), 0);
  if (total !== 1000) {
    return { ok: false, message: `The pieces add up to ${fmtPercent(total)}%. They need to add up to 100%.` };
  }

  const [course] = await database
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.id, input.courseId), eq(courses.userId, userId)))
    .limit(1);
  if (!course) return { ok: false, message: MSG.notHers };

  const itemRows = input.rows.filter((r) => r.kind === "item");
  const newRows = input.rows.filter((r) => r.kind === "new");
  const sent = new Set(itemRows.map((r) => r.id));
  if (sent.size !== itemRows.length) return { ok: false, message: MSG.invalid };

  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const stored = await tx
      .select({ id: gradeItems.id })
      .from(gradeItems)
      .where(and(eq(gradeItems.userId, userId), eq(gradeItems.courseId, course.id)));
    const storedIds = new Set(stored.map((r) => r.id));
    // An id that is not one of her items in this course: not hers, or moved.
    if (itemRows.some((r) => !storedIds.has(r.id))) return { ok: false, message: MSG.notHers };
    // A piece she did not see in the form (a sync added it): ask her to look again.
    if (storedIds.size !== sent.size) return { ok: false, message: MSG.changed };

    for (const r of itemRows) {
      await tx
        .update(gradeItems)
        .set({ weight: (tenthsOf(r.percent) as number) / 1000, weightSource: "manual" })
        .where(and(eq(gradeItems.userId, userId), eq(gradeItems.id, r.id)));
    }

    if (newRows.length > 0) {
      const [last] = await tx
        .select({ position: max(gradeItems.position) })
        .from(gradeItems)
        .where(and(eq(gradeItems.userId, userId), eq(gradeItems.courseId, course.id)));
      const start = (last?.position ?? -1) + 1;
      await tx.insert(gradeItems).values(
        newRows.map((r, i) => ({
          userId,
          courseId: course.id,
          moodleRef: `manual:${randomUUID()}`,
          name: r.name,
          short: shortLabel(r.name),
          max: 100,
          score: null,
          position: start + i,
          weight: (tenthsOf(r.percent) as number) / 1000,
          weightSource: "manual" as const,
        })),
      );
    }
    return { ok: true } as const;
  });
}

async function signedInUser(): Promise<User | null> {
  try {
    return await currentUser();
  } catch (err) {
    if (err instanceof NotSignedIn) return null;
    throw err;
  }
}

const SIGNED_OUT = "You are signed out. Reload the page and try again.";

/** Saves her weights for one course. The action `WeightsForm` takes. */
export async function saveWeightsAction(courseId: string, rows: WeightRow[]): Promise<SaveWeightsResult> {
  "use server";
  const user = await signedInUser();
  if (!user) return { ok: false, message: SIGNED_OUT };
  const result = await saveWeightsFor(defaultDb, user.id, courseId, rows);
  if (result.ok) {
    revalidatePath("/grades", "layout");
    revalidatePath("/courses", "layout");
  }
  return result;
}

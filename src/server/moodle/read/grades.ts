// Reads her grades in one course (gradereport_user_get_grade_items): one row
// per graded activity or manual item, without the category totals and the
// course total.
// Cut: no letter grades, no scale names, no feedback text. Numbers only.

import { z } from "zod";
import { callMoodle, type MoodleConn } from "../client";
import { parseAnswer } from "./site";

const FN = "gradereport_user_get_grade_items";

// The user report fills many fields only when its matching column is shown
// (grade, range, percentage, weight...), so everything past the item's own
// identity is optional. Fields Moodle may send as null are nullish.
const GradeItem = z.object({
  id: z.number().int(),
  // Null for the course total and for category totals.
  itemname: z.string().nullish(),
  // "mod", "manual", "category" or "course". Kept as text so a new type reads as "other".
  itemtype: z.string(),
  // "assign", "quiz", "forum"...; null for manual items and totals.
  itemmodule: z.string().nullish(),
  iteminstance: z.number().int().nullish(),
  cmid: z.number().int().optional(),
  // A fraction of the course total (0.2 = 20 %). Missing when the report hides the weight column.
  weightraw: z.number().nullish(),
  // Null until she is graded.
  graderaw: z.number().nullish(),
  grademin: z.number().optional(),
  grademax: z.number().optional(),
  // Unix seconds; null (or 0) until graded.
  gradedategraded: z.number().int().nonnegative().nullish(),
  gradeishidden: z.boolean().optional(),
  // Hidden until a set date ("hidden until" on the item).
  gradehiddenbydate: z.boolean().optional(),
});

const GradeItemsAnswer = z.object({
  usergrades: z.array(
    z.object({
      courseid: z.number().int(),
      userid: z.number().int(),
      gradeitems: z.array(GradeItem),
    }),
  ),
});

// Totals Moodle computes from the other items; we compute our own from the rows.
const TOTALS = new Set(["category", "course"]);

export type GradeKind = "assign" | "quiz" | "manual" | "other";

export type GradeItemRow = {
  /** `gradeitem:<Moodle grade item id>`. */
  moodleRef: string;
  name: string;
  kind: GradeKind;
  /** Highest grade possible; null when Moodle does not send the range. */
  max: number | null;
  /** Her grade as Moodle stores it; null until graded. */
  score: number | null;
  /** 0 to 100, unrounded; null until graded or when the range is unknown. */
  percent: number | null;
  /**
   * Share of the course total as Moodle sends it: a fraction from 0 to 1
   * (0.2 = 20 %), not a percentage. Null when Moodle gives no weight; the app
   * then asks her to type one in.
   */
  weight: number | null;
  gradedAt: Date | null;
  /** Moodle hides this grade from her (by the teacher, or until a date). */
  hidden: boolean;
};

type RawItem = z.output<typeof GradeItem>;

function kindOf(item: RawItem): GradeKind {
  if (item.itemtype === "manual") return "manual";
  if (item.itemtype === "mod" && (item.itemmodule === "assign" || item.itemmodule === "quiz")) return item.itemmodule;
  return "other";
}

// We compute the percent from the numbers instead of reading
// `percentageformatted`: that is display text in her site's language and
// number format ("85.00 %", "85,00 %", "-"), sent only when the report shows
// the percentage column. Moodle's own formula is the same:
// (grade - min) / (max - min) * 100.
function percentOf(score: number | null, min: number, max: number | null): number | null {
  if (score === null || max === null || max <= min) return null;
  return ((score - min) / (max - min)) * 100;
}

function toRow(item: RawItem): GradeItemRow {
  const score = item.graderaw ?? null;
  const max = item.grademax ?? null;
  return {
    moodleRef: `gradeitem:${item.id}`,
    name: item.itemname ?? "",
    kind: kindOf(item),
    // A scale item (a grade picked from a list of words) arrives as its
    // position on the scale, with grademin 1 and grademax the number of words.
    // We keep it as that plain number, since the scale's words are cut.
    max,
    score,
    percent: percentOf(score, item.grademin ?? 0, max),
    weight: typeof item.weightraw === "number" ? item.weightraw : null,
    gradedAt: item.gradedategraded ? new Date(item.gradedategraded * 1000) : null,
    hidden: Boolean(item.gradeishidden || item.gradehiddenbydate),
  };
}

/**
 * Her grade items in one course, in Moodle's report order, totals left out.
 * Moodle answers one entry per user; we keep the one for `userId` and return
 * [] if it is not there.
 */
export async function getGradeItems(conn: MoodleConn, courseMoodleId: number, userId: number): Promise<GradeItemRow[]> {
  const raw = await callMoodle(conn, FN, { courseid: courseMoodleId, userid: userId });
  const answer = parseAnswer(FN, GradeItemsAnswer, raw);
  const mine = answer.usergrades.find((u) => u.userid === userId);
  if (!mine) return [];
  return mine.gradeitems.filter((item) => !TOTALS.has(item.itemtype)).map(toRow);
}

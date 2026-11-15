/*
 * M2-27: a course's AI rules, in two parts. Pure: no database, no imports.
 *
 *   assignmentHelp(course)   'off' | 'explain' | 'allowed'
 *   studyAllowed(course)     true | false
 *
 * A course can forbid AI for writing assignment answers while its lecture slides may still be
 * studied with AI, so one value cannot hold both. The columns (src/server/db/schema/courses.ts):
 *
 *   courses.ai_assignments   'unknown' | 'off' | 'explain' | 'allowed'
 *     off       no assignment chat at all, no draft, and the brief goes to no model.
 *     explain   the chat explains and gives feedback; it gets no course text and writes no draft.
 *     allowed   the chat reads the brief (and her files, if her own switch is on) and may draft.
 *     unknown   she has not said. Counts as off: nothing is sent until she answers.
 *
 *   courses.ai_study         'unknown' | 'allowed' | 'not_allowed'
 *     allowed   cards and lecture pages may be made from the course's slides.
 *     anything else: they may not.
 *
 * Every reader of the two columns goes through these two functions, so "unknown" can never be
 * read as a yes by mistake.
 */

/** `courses.ai_assignments`. */
export type AiAssignments = "unknown" | "off" | "explain" | "allowed";
/** `courses.ai_study`. */
export type AiStudy = "unknown" | "allowed" | "not_allowed";
/** What the assignment chat may do for a course. */
export type AssignmentHelp = "off" | "explain" | "allowed";

/** AI help on this course's assignments. "unknown", or any value we do not know, is "off". */
export function assignmentHelp(course: { aiAssignments: AiAssignments }): AssignmentHelp {
  const value: string = course.aiAssignments;
  return value === "allowed" || value === "explain" ? value : "off";
}

/** True only when the course's study material may go to an AI model (`ai_study` is 'allowed'). */
export function studyAllowed(course: { aiStudy: AiStudy }): boolean {
  return course.aiStudy === "allowed";
}

/*
 * M2-26, M2-27: may her course files go to an AI model?
 *
 *   if (await mayUseFiles(userId, courseId)) { ...make cards or a lecture page from the slides... }
 *   if (await mayUseFilesForAssignment(userId, courseId)) { ...put file text in the chat... }
 *
 * A course has two AI rules (src/lib/ai-policy.ts), so there are two questions:
 *
 *   mayUseFiles                study material. True only when the course is hers, the course's
 *                              study rule is yes (`courses.ai_study = 'allowed'`), and her own
 *                              switch is on. Card, concept and lecture-page jobs ask this.
 *   mayUseFilesForAssignment   the assignment chat. True only when the course is hers, AI help on
 *                              its assignments is fully allowed (`courses.ai_assignments =
 *                              'allowed'`), and her own switch is on. The chat asks this before
 *                              it reads a file.
 *
 * The two do not imply each other: a course may forbid AI on homework while its slides may be
 * studied with AI, and the other way round.
 *
 * Aalto's guidance (context/moodle/terms.md, point d) is that teachers' material goes to outside
 * AI services only where the course permits it, so both rules start at "unknown", which is a no.
 * Her own switch `users.settings.ai.useFiles` is on until she turns it off (Settings, "What Ready
 * keeps"). An unknown user or course, or a malformed id, is false.
 *
 * No AI SDK and no router in here, so files outside src/server/ai may import it.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { assignmentHelp, studyAllowed } from "@/lib/ai-policy";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { users } from "@/server/db/schema/users";

/** Her switch, read from `users.settings`. On unless it was set to exactly `false`. */
export function filesSwitchOn(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return true;
  const ai = (settings as Record<string, unknown>).ai;
  if (typeof ai !== "object" || ai === null) return true;
  return (ai as Record<string, unknown>).useFiles !== false;
}

/** Her course's two AI rules and her settings; undefined when the course is not hers. */
async function rulesFor(userId: string, courseId: string, database: Db) {
  if (!z.uuid().safeParse(userId).success || !z.uuid().safeParse(courseId).success) return undefined;
  const [row] = await database
    .select({ settings: users.settings, aiAssignments: courses.aiAssignments, aiStudy: courses.aiStudy })
    .from(courses)
    .innerJoin(users, eq(users.id, courses.userId))
    .where(and(eq(courses.id, courseId), eq(courses.userId, userId)))
    .limit(1);
  return row;
}

/** True when this course's study material (file text) may be sent to an AI model for this user. */
export async function mayUseFiles(userId: string, courseId: string, database: Db = defaultDb): Promise<boolean> {
  const row = await rulesFor(userId, courseId, database);
  if (!row) return false;
  return studyAllowed(row) && filesSwitchOn(row.settings);
}

/** True when the assignment chat of this course may read her file text. */
export async function mayUseFilesForAssignment(
  userId: string,
  courseId: string,
  database: Db = defaultDb,
): Promise<boolean> {
  const row = await rulesFor(userId, courseId, database);
  if (!row) return false;
  return assignmentHelp(row) === "allowed" && filesSwitchOn(row.settings);
}

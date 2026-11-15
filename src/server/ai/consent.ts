/*
 * M2-26: may her course files go to an AI model?
 *
 *   if (await mayUseFiles(userId, courseId)) { ...put file text in the prompt... }
 *
 * True only when all three hold:
 *   - the course is hers,
 *   - the course is marked as allowing AI (`courses.ai_policy = 'allowed'`). Aalto's guidance
 *     (context/moodle/terms.md, point d) is that teachers' material goes to outside AI services
 *     only where the course permits it, so a course starts at "no";
 *   - her own switch `users.settings.ai.useFiles` is not off. It is on until she turns it off
 *     (Settings, "What Ready keeps").
 *
 * Every AI job that reads her files asks this first: the chat works from the brief only when it
 * is false; card, concept and lecture-page jobs skip the course. An unknown user or course, or a
 * malformed id, is false.
 *
 * No AI SDK and no router in here, so files outside src/server/ai may import it.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
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

/** True when this course's file text may be sent to an AI model for this user. */
export async function mayUseFiles(userId: string, courseId: string, database: Db = defaultDb): Promise<boolean> {
  if (!z.uuid().safeParse(userId).success || !z.uuid().safeParse(courseId).success) return false;
  const [row] = await database
    .select({ settings: users.settings, aiPolicy: courses.aiPolicy })
    .from(courses)
    .innerJoin(users, eq(users.id, courses.userId))
    .where(and(eq(courses.id, courseId), eq(courses.userId, userId)))
    .limit(1);
  if (!row) return false;
  return row.aiPolicy === "allowed" && filesSwitchOn(row.settings);
}

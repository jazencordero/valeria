"use server";

/**
 * M2-21: store her answer to "Does <course> allow AI help on homework?".
 *
 * The client sends only the course id and the new value; who she is comes
 * from the session cookie, and the update matches on both the course id and
 * her user id, so another user's course is never touched (it reads as
 * "not_found", the same as a course that does not exist).
 *
 * Every export of a "use server" file is a public endpoint, so there is no
 * exported helper that takes a user id or a database handle. Tests call the
 * action itself with the session and database mocked.
 */
import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { AI_POLICIES, courses } from "@/server/db/schema/courses";

/** `courses.ai_policy`: "unknown" | "allowed" | "not_allowed". */
export type AiPolicy = (typeof AI_POLICIES)[number];

export type PolicyResult =
  | { ok: true; policy: AiPolicy }
  | { ok: false; reason: "invalid" | "not_found" | "signed_out" };

const Input = z.object({
  courseId: z.uuid(),
  policy: z.enum(AI_POLICIES),
});

export async function setCourseAiPolicy(courseId: unknown, policy: unknown): Promise<PolicyResult> {
  const parsed = Input.safeParse({ courseId, policy });
  if (!parsed.success) return { ok: false, reason: "invalid" };

  let userId: string;
  try {
    userId = (await currentUser()).id;
  } catch (err) {
    if (err instanceof NotSignedIn) return { ok: false, reason: "signed_out" };
    throw err;
  }

  const [row] = await db
    .update(courses)
    .set({ aiPolicy: parsed.data.policy })
    .where(and(eq(courses.id, parsed.data.courseId), eq(courses.userId, userId)))
    .returning({ aiPolicy: courses.aiPolicy });
  if (!row) return { ok: false, reason: "not_found" };

  // The page reads the policy on the server; re-render it with the new value.
  refresh();
  return { ok: true, policy: row.aiPolicy };
}

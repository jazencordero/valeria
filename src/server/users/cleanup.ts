/*
 * Clean up visitors who never came back (M2-25).
 *
 *   const { anonymous, demo } = await cleanup();   // what the `cleanup` job runs
 *
 * Every visitor gets a user row (from the session cookie), so rows pile up.
 * `cleanup` deletes two kinds of idle user, in one statement:
 *
 * - anonymous: not a demo user, no `moodle_connections` row, no study data
 *   (no row in `courses`, `exams` or `cards`), last active more than
 *   ANONYMOUS_IDLE_DAYS (30) days ago;
 * - demo: `users.settings.demo` is true, last active more than DEMO_IDLE_DAYS
 *   (7) days ago. A demo user always holds the fake Moodle's connection
 *   (see `@/server/demo/seed`), so for demo users the connection does not count.
 *
 * A user who is not a demo user is never deleted, however long she has been
 * away, if she has a Moodle connection (the ticket's cut) or owns any study
 * data: a course, an exam or a card. The real student's account can be filled
 * by the M3-51 importer (`--user <id>`) without any Moodle connection, and it
 * must survive. Demo users keep the plain 7-day rule, data or not.
 *
 * "Last active" is the newest `sessions.last_seen_at` of the user's sessions.
 * The session code moves it forward at most once an hour while she uses the
 * app, so it can lag by up to an hour; that is nothing against 7 or 30 days.
 * A user with no session left (signed out everywhere, or merged) falls back to
 * `users.created_at`.
 *
 * Everything the user had goes with the row: every table that holds a
 * `user_id` references `users(id) on delete cascade` (`userId()` in the
 * schema), except provider metrics (`ai_calls`), which keep the row with
 * `user_id` set to null.
 *
 * Not done here: the fake Moodle's in-memory record of a deleted demo user's
 * hand-ins (`resetFake`) lives in one server instance's memory and is not
 * dropped; it is keyed by the deleted user id, so nobody can reach it again.
 */
import { sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { users } from "@/server/db/schema/users";
import { DEMO_FLAG } from "@/server/demo/seed";

export const ANONYMOUS_IDLE_DAYS = 30;
export const DEMO_IDLE_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

export type CleanupResult = {
  /** Non-demo users with no Moodle connection and no study data, idle for over 30 days, that were deleted. */
  anonymous: number;
  /** Demo users idle for over 7 days that were deleted. */
  demo: number;
};

/** `users.settings.demo` is JSON true. Never NULL, so `not` works on it. */
export const isDemoSql = sql`coalesce((${users.settings} -> ${DEMO_FLAG}::text) = 'true'::jsonb, false)`;

export async function cleanup(now: Date = new Date(), database: Db = defaultDb): Promise<CleanupResult> {
  const anonymousBefore = new Date(now.getTime() - ANONYMOUS_IDLE_DAYS * DAY_MS);
  const demoBefore = new Date(now.getTime() - DEMO_IDLE_DAYS * DAY_MS);
  // Newest session activity, or the user's creation when no session is left.
  // The outer row is named in full ("users"."id"): drizzle may print a column
  // of the table being deleted from without its table, and a bare "id" inside
  // these subqueries would mean the session's or connection's own id.
  const lastActive = sql`coalesce(
    (select max(s.last_seen_at) from sessions s where s.user_id = "users"."id"),
    "users"."created_at"
  )`;
  const connected = sql`exists (select 1 from moodle_connections m where m.user_id = "users"."id")`;
  const ownsStudyData = sql`(
    exists (select 1 from courses c where c.user_id = "users"."id")
    or exists (select 1 from exams e where e.user_id = "users"."id")
    or exists (select 1 from cards k where k.user_id = "users"."id")
  )`;

  const rows = await database
    .delete(users)
    .where(
      sql`(
        (${isDemoSql} and ${lastActive} < ${demoBefore.toISOString()}::timestamptz)
        or (not ${isDemoSql} and not ${connected} and not ${ownsStudyData} and ${lastActive} < ${anonymousBefore.toISOString()}::timestamptz)
      )`,
    )
    .returning({ id: users.id, settings: users.settings });

  const demo = rows.filter((r) => r.settings?.[DEMO_FLAG] === true).length;
  return { anonymous: rows.length - demo, demo };
}

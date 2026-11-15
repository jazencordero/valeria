/*
 * When the cleanup runs, and the demo's brake (M2-25).
 *
 *   await scheduleCleanup();   // GET /demo, every visit
 *   if (await demoBusy()) ...  // GET /demo, before it makes a demo user
 *
 * scheduleCleanup: adds at most one `cleanup` job per day (UTC). The job's
 * payload names its day, and a job for today in any state (queued, running,
 * done, failed) means nothing is added; a job that used up its five tries
 * waits for tomorrow's job instead of being re-added on every visit. The day is also the job's dedupeKey, so two visits at the same moment
 * still add only one. Cost per visit: one small select on `jobs`, plus one
 * insert on the first visit of the day. The hourly tick then calls
 * /api/cron/cleanup, which runs it.
 *
 * demoBusy: true once DEMO_PER_HOUR (20) demo users have been made in the past
 * hour, in total across all visitors. "Made" is read from the table, not kept
 * in a counter: a demo user whose fake Moodle connection was made (its
 * `connected_at`, written by every demo seed, including a reset) within the
 * hour. A reset deletes the old demo user, so resetting your own demo does not
 * add up; only new demo users do. The check and the seed that follows are not
 * one transaction, so visitors arriving at the same instant can go a few past
 * 20; it is a brake, not a quota.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { moodleConnections } from "@/server/db/schema/moodle";
import { jobs } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { enqueue } from "@/server/jobs/queue";
import { isDemoSql } from "./cleanup";

export const CLEANUP_KIND = "cleanup";
export const DEMO_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;

export type ScheduleOptions = { db?: Db; now?: () => Date };

/** The UTC day of `at`, as YYYY-MM-DD. */
export function cleanupDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Adds today's cleanup job unless one exists. `created` says whether this call added it. */
export async function scheduleCleanup({ db = defaultDb, now = () => new Date() }: ScheduleOptions = {}): Promise<{
  created: boolean;
}> {
  const day = cleanupDay(now());
  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, CLEANUP_KIND), sql`${jobs.payload}->>'day' = ${day}`))
    .limit(1);
  if (existing) return { created: false };
  const { created } = await enqueue(CLEANUP_KIND, { day }, { dedupeKey: day, db, now });
  return { created };
}

/** Whether DEMO_PER_HOUR demo users have been made in the hour before `now`. */
export async function demoBusy({ db = defaultDb, now = () => new Date() }: ScheduleOptions = {}): Promise<boolean> {
  const since = new Date(now().getTime() - HOUR_MS);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(moodleConnections)
    .innerJoin(users, eq(users.id, moodleConnections.userId))
    .where(and(isDemoSql, gte(moodleConnections.connectedAt, since)));
  return (row?.n ?? 0) >= DEMO_PER_HOUR;
}

/*
 * Keeps her Moodle data fresh while the app is closed (M7-05).
 *
 *   await scheduleSyncs();                        // the hourly tick, before it drains anything
 *   await runBackgroundSync(userId);              // /api/cron/sync, once per `sync` job
 *
 * scheduleSyncs(opts) adds one `sync` job for every user who is due:
 * - her Moodle connection has status 'ok'. 'expired' (Moodle rejected her
 *   key), 'revoked' and 'error' are never scheduled; `connectWithKey` sets
 *   'ok' again when she reconnects, and from then on she is scheduled again.
 * - her data is older than STALE_MS (6 hours). "Her data" is the newer of
 *   `last_sync_at` and `connected_at`: right after a (re)connect her first
 *   sync runs in the foreground (M5-07), so a background one must not start
 *   beside it, and a connection whose first sync never finished
 *   (`last_sync_at` null) still gets one 6 hours after she connected.
 * - she is not a demo user. A demo user's data is the demo seed's, not
 *   Moodle's, and a sync must not overwrite it.
 * - she has no `sync` job queued or running. The job's dedupeKey is her user
 *   id too, so two ticks at the same moment still add only one.
 * - fewer than MAX_PER_DAY (4) `sync` jobs were made for her in the past
 *   24 hours, in any state (done, failed, or ended without a sync). Counted
 *   from the jobs table, not kept anywhere else. A rolling 24 hours, not a
 *   calendar day, so no time zone is involved. With 6-hourly freshness she
 *   needs about 3 a day; the cap matters when a sync keeps not finishing
 *   (Moodle down: `last_sync_at` is not set, so she stays due every hour).
 *
 * Jitter: each job's `run_after` is `now` plus up to JITTER_MS (2 hours), so
 * the users who go stale together are spread over the next two ticks instead
 * of all calling MyCourses in the same minute. The offset is deterministic:
 * a hash of her user id and the UTC day (`jitterFraction`), so it differs per
 * user and per day and tests can predict it. Tests may pass their own
 * `jitter`. Worst case she is synced about 6 h + 2 h + one tick after the
 * last sync; opening the app syncs her anyway.
 *
 * runBackgroundSync(userId, opts) is one job's work:
 * - Not connected, or status not 'ok': nothing is asked of Moodle (`skipped`).
 * - She synced in the meantime (she opened the app after the job was added,
 *   so her data is no longer stale and no sync is half done): `skipped` too.
 * - Otherwise `syncNow(userId, { force: true })` again while it says `more`,
 *   up to JOB_BUDGET_MS and MAX_SYNC_CALLS, like `runFirstSync` (./progress).
 *   `force` continues an unfinished sync rather than restarting it (./run).
 * - A rejected key: `syncNow` itself marks her connection 'expired' and says
 *   so; the job ends (`expired`) and is not tried again. Moodle down:
 *   `syncNow` saves `last_error` and says `more: false`; the job ends
 *   (`unfinished`) without a retry from the queue, because the next tick
 *   schedules her again while she is stale, at most MAX_PER_DAY times a day.
 *   That is politer to MyCourses than the queue's five quick tries.
 * - Anything `syncNow` throws is a bug or the database; it is thrown, so the
 *   queue tries that job again later.
 *
 * The Moodle client's own limits (two calls in flight per user, a gap between
 * calls, the daily count; ../moodle/client) apply to every call made here.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { moodleConnections } from "@/server/db/schema/moodle";
import { jobs } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { enqueue } from "@/server/jobs/queue";
import { isDemoSql } from "@/server/users/cleanup";
import { cursorFrom, syncNow, type MoodleStatus, type SyncNowDeps } from "./run";

export const SYNC_KIND = "sync";
/** Data older than this is refreshed in the background. */
export const STALE_MS = 6 * 60 * 60_000;
/** Most `sync` jobs per user in any 24 hours. */
export const MAX_PER_DAY = 4;
/** A job's `run_after` is up to this far after the tick that added it. */
export const JITTER_MS = 2 * 60 * 60_000;
/** No new `syncNow` call starts after this much of one job. */
export const JOB_BUDGET_MS = 60_000;
/** Most `syncNow` calls in one job, so a sync that never says `more: false` still ends. */
export const MAX_SYNC_CALLS = 20;

const DAY_MS = 24 * 60 * 60_000;
const LIVE = ["queued", "running"] as const;

/** A number in [0, 1) from her user id and the UTC day of `at`: the same all day, different per user. */
export function jitterFraction(userId: string, at: Date): number {
  // FNV-1a, 32 bit: tiny, stable across processes, and spreads short inputs well.
  const text = `${userId}:${at.toISOString().slice(0, 10)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 2 ** 32;
}

export type ScheduleSyncsOptions = {
  db?: Db;
  now?: () => Date;
  /** A number in [0, 1) per user; her job runs `jitter * JITTER_MS` after now. Default `jitterFraction`. */
  jitter?: (userId: string, at: Date) => number;
};

export type ScheduleSyncsResult = {
  /** Users a job was added for, with when it runs. */
  queued: { userId: string; runAfter: Date }[];
};

/** Adds a `sync` job for every user who is due (see the header). */
export async function scheduleSyncs({
  db = defaultDb,
  now = () => new Date(),
  jitter = jitterFraction,
}: ScheduleSyncsOptions = {}): Promise<ScheduleSyncsResult> {
  const at = now();
  const staleBefore = new Date(at.getTime() - STALE_MS);
  const dayAgo = new Date(at.getTime() - DAY_MS);

  // `greatest` skips a null `last_sync_at`, leaving `connected_at`.
  const dataAt = sql`greatest(${moodleConnections.lastSyncAt}, ${moodleConnections.connectedAt})`;
  const live = db
    .select({ one: sql`1` })
    .from(jobs)
    .where(and(eq(jobs.kind, SYNC_KIND), eq(jobs.userId, moodleConnections.userId), inArray(jobs.status, [...LIVE])));
  const today = db
    .select({ n: sql`count(*)` })
    .from(jobs)
    .where(and(eq(jobs.kind, SYNC_KIND), eq(jobs.userId, moodleConnections.userId), gte(jobs.createdAt, dayAgo)));

  const due = await db
    .select({ userId: moodleConnections.userId })
    .from(moodleConnections)
    .innerJoin(users, eq(users.id, moodleConnections.userId))
    .where(
      and(
        eq(moodleConnections.status, "ok"),
        sql`${dataAt} < ${staleBefore.toISOString()}::timestamptz`,
        sql`not ${isDemoSql}`,
        sql`not exists (${live})`,
        sql`(${today}) < ${MAX_PER_DAY}`,
      ),
    )
    .orderBy(moodleConnections.userId);

  const queued: ScheduleSyncsResult["queued"] = [];
  for (const { userId } of due) {
    const fraction = Math.min(Math.max(jitter(userId, at), 0), 1);
    const runAfter = new Date(at.getTime() + Math.floor(fraction * JITTER_MS));
    const { created } = await enqueue(SYNC_KIND, {}, { userId, dedupeKey: userId, runAfter, db, now: () => at });
    if (created) queued.push({ userId, runAfter });
  }
  return { queued };
}

export type BackgroundSyncOptions = {
  db?: Db;
  /** What `syncNow` reads Moodle with. Default: the real (or fake) Moodle. */
  deps?: SyncNowDeps;
  now?: () => number;
};

export type BackgroundSyncResult = {
  /**
   * - `synced`: the sync finished.
   * - `unfinished`: it stopped before the end (Moodle down, or out of time); a cursor or `last_error` says where.
   * - `expired`: Moodle rejected her key; her connection is now 'expired'.
   * - `skipped`: nothing was asked of Moodle (not connected, status not 'ok', or fresh already).
   */
  outcome: "synced" | "unfinished" | "expired" | "skipped";
  /** `syncNow` calls made. */
  calls: number;
};

/** One `sync` job: brings her data up to date, or as far as JOB_BUDGET_MS allows. */
export async function runBackgroundSync(
  userId: string,
  { db = defaultDb, deps, now = () => Date.now() }: BackgroundSyncOptions = {},
): Promise<BackgroundSyncResult> {
  const startedAt = now();
  const [link] = await db
    .select({
      status: moodleConnections.status,
      lastSyncAt: moodleConnections.lastSyncAt,
      connectedAt: moodleConnections.connectedAt,
    })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);
  if (!link || link.status !== "ok") return { outcome: "skipped", calls: 0 };

  const [me] = await db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).limit(1);
  const dataAt = Math.max(link.lastSyncAt?.getTime() ?? 0, link.connectedAt.getTime());
  if (cursorFrom(me?.settings) === null && startedAt - dataAt < STALE_MS) return { outcome: "skipped", calls: 0 };

  let calls = 0;
  let status: MoodleStatus | "not_connected" = link.status;
  let more = true;
  while (more && calls < MAX_SYNC_CALLS && now() - startedAt < JOB_BUDGET_MS) {
    calls += 1;
    const step = await syncNow(userId, { force: true }, db, deps);
    status = step.status;
    more = step.more;
    if (!step.ran) break;
  }

  if (status === "expired" || status === "revoked") return { outcome: "expired", calls };
  if (status === "not_connected") return { outcome: "skipped", calls };
  if (more) return { outcome: "unfinished", calls };
  // `more: false` is also what a Moodle error says; only a finished sync clears the cursor and sets `last_sync_at`.
  const [after] = await db
    .select({ lastSyncAt: moodleConnections.lastSyncAt })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);
  const [meAfter] = await db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).limit(1);
  const before = link.lastSyncAt?.getTime() ?? null;
  const finished =
    after?.lastSyncAt != null && after.lastSyncAt.getTime() !== before && cursorFrom(meAfter?.settings) === null;
  return { outcome: finished ? "synced" : "unfinished", calls };
}

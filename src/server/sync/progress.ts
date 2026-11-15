/*
 * How far her first Moodle sync has got, for the sorting scene (M5-07).
 *
 *   const { stage, courses, files, dates } = await syncProgress(userId);
 *   const { started } = startFirstSync(userId); // inside a request: runs after the response
 *
 * The client calls GET /api/sync/progress once a second while first run is on
 * screen (polling, not a stream: the ticket's cut).
 *
 * Counts, all hers only, read from the tables:
 * - `courses`: names of her visible courses (`hidden = false`), in the order
 *   they were stored (`created_at`), then by name, then id. One sync writes all
 *   courses at once, so in practice this is a-z by name, and a later course is
 *   added at the end instead of moving the others.
 * - `files`: her `course_files` rows. Brief attachments are written during the
 *   assignments step, course-page files by the files step, so this rises in both.
 * - `dates`: her `events` rows from Moodle (`source = 'moodle'`), not her own.
 *
 * `stage` is the step being worked on now, taken from the sync's own state,
 * not guessed from counts where that state exists:
 * 1. A sync cursor in `users.settings.syncCursor` (./run): an unfinished sync.
 *    `datesDone` set means 'grades' (only her grades are left), `assignmentsDone`
 *    alone means 'dates', otherwise 'assignments'.
 * 2. No cursor, `moodle_connections.last_sync_at` set (a sync finished): her
 *    `sync-files` job (./files) still queued or running means 'files',
 *    otherwise 'done'. A failed files job also counts as 'done': it will not
 *    run again, and the scene must not wait for ever.
 * 3. Neither, so the first sync has not finished and has saved no cursor yet:
 *    'courses' while she has no course rows, 'assignments' once she has. Here
 *    a count is the only signal: the first call of a sync saves its cursor only
 *    when it runs out of time, so a fast Moodle finishes courses, assignments
 *    and dates in one call and the cursor is never seen.
 *
 * So the order she sees is courses, assignments, dates, grades, files, done
 * (`STAGE_ORDER`). Dates and grades come before files because that is the
 * order the sync runs in: `syncNow` syncs the dates, then the grades, then
 * marks itself finished and adds the `sync-files` job. Stages can be skipped between two polls, never go back
 * during one first sync. 'done' means: the sync finished and her course files
 * are listed (or listing them failed for good).
 *
 * No Moodle connection, or a key Moodle rejected, leaves the stage where it
 * stopped (often 'courses'); the client stops polling after a while and shows
 * the connection's state, which this does not report.
 *
 * startFirstSync(userId) starts the forced sync without waiting for it: the
 * work is handed to `after` (next/server), which runs it once the response is
 * sent, for as long as the route's `maxDuration` allows. Called outside a
 * request (a script, a test without `schedule`), `after` throws and the work
 * runs as a detached promise instead. The work (`runFirstSync`):
 * - Calls `syncNow(userId, { force: true })` again while it says `more`, up to
 *   SYNC_BUDGET_MS. `force` continues an unfinished sync rather than restarting
 *   it (see ./run). A sync that already finished is not forced again: first
 *   run must not repeat a whole sync because she reloaded the page.
 * - Then, if her `sync-files` job is still queued, lists her files right away
 *   (`syncFiles`) instead of waiting up to an hour for the cron tick, and marks
 *   that queued job done, because its work is done. A job the cron has already
 *   claimed (`running`) is left to the cron. Disconnected, rejected key, or a
 *   key that may not read course pages: the job is marked done too, like the
 *   cron route does, since trying again cannot help. Any other error (Moodle
 *   down) leaves the job queued for the cron to try again.
 * - Starts no new step after its budget; what is left (a saved cursor, a
 *   queued job) is picked up by the next startFirstSync, the next app open, or
 *   the cron.
 *
 * Idempotent: a second call while one is scheduled or running for the same
 * user starts nothing and says `started: false`. The guard is an in-memory set
 * in this server process. Limits: two server instances (serverless can run
 * several) do not see each other's set, so each may run one; `syncNow` has no
 * lock of its own, so then Moodle is asked twice but every row is still written
 * once. A process that dies mid-sync takes its set with it, and the saved
 * cursor lets the next call continue.
 */
import { after } from "next/server";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { events } from "@/server/db/schema/calendar";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { jobs } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { KeyRejected, NotAllowed } from "@/server/moodle/client";
import { NotConnected } from "./courses";
import { SYNC_FILES_KIND, syncFiles, type SyncFilesDeps } from "./files";
import { cursorFrom, syncNow, type SyncNowDeps } from "./run";

export type SyncStage = "courses" | "assignments" | "dates" | "grades" | "files" | "done";

/** The order the stages happen in (see the header: dates and grades before files). */
export const STAGE_ORDER: readonly SyncStage[] = ["courses", "assignments", "dates", "grades", "files", "done"];

export type SyncProgress = {
  stage: SyncStage;
  /** Names of her visible courses so far, in a stable order. */
  courses: string[];
  files: number;
  dates: number;
};

/** No new `syncNow` call starts after this much of one first-sync run. */
export const SYNC_BUDGET_MS = 150_000;
/** Her files are not listed in this run once this much has passed; the cron does it. */
export const FILES_BUDGET_MS = 200_000;
/** Most `syncNow` calls in one run, so a sync that never says `more: false` still ends. */
export const MAX_SYNC_CALLS = 40;

/** A sync-files job that may still run: the files step is not over. */
const LIVE_JOB = ["queued", "running"] as const;

export async function syncProgress(userId: string, database: Db = defaultDb): Promise<SyncProgress> {
  const [courseRows, [fileCount], [dateCount], [link], [me], [filesJob]] = await Promise.all([
    database
      .select({ name: courses.name })
      .from(courses)
      .where(and(eq(courses.userId, userId), eq(courses.hidden, false)))
      .orderBy(asc(courses.createdAt), asc(courses.name), asc(courses.id)),
    database.select({ n: count() }).from(courseFiles).where(eq(courseFiles.userId, userId)),
    database
      .select({ n: count() })
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.source, "moodle"))),
    database
      .select({ lastSyncAt: moodleConnections.lastSyncAt })
      .from(moodleConnections)
      .where(eq(moodleConnections.userId, userId))
      .limit(1),
    database.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).limit(1),
    database
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.userId, userId), eq(jobs.kind, SYNC_FILES_KIND), inArray(jobs.status, [...LIVE_JOB])))
      .limit(1),
  ]);

  const names = courseRows.map((c) => c.name);
  const cursor = cursorFrom(me?.settings);
  let stage: SyncStage;
  if (cursor) stage = cursor.datesDone ? "grades" : cursor.assignmentsDone ? "dates" : "assignments";
  else if (link?.lastSyncAt) stage = filesJob ? "files" : "done";
  else stage = names.length > 0 ? "assignments" : "courses";

  return { stage, courses: names, files: Number(fileCount?.n ?? 0), dates: Number(dateCount?.n ?? 0) };
}

export type FirstSyncDeps = {
  /** What `syncNow` reads Moodle with. Default: the real (or fake) Moodle. */
  sync?: SyncNowDeps;
  /** What `syncFiles` reads course pages with. */
  files?: SyncFilesDeps;
  now?: () => number;
};

export type FirstSyncResult = {
  /** `syncNow` calls made. */
  calls: number;
  /** True when this run listed her files. */
  filesListed: boolean;
};

/** Runs her first sync to the end, or as far as the budget allows. Awaitable; `startFirstSync` does not wait. */
export async function runFirstSync(
  userId: string,
  database: Db = defaultDb,
  deps: FirstSyncDeps = {},
): Promise<FirstSyncResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const result: FirstSyncResult = { calls: 0, filesListed: false };

  const [link] = await database
    .select({ lastSyncAt: moodleConnections.lastSyncAt })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);
  if (!link) return result;
  const [me] = await database.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).limit(1);
  const finished = link.lastSyncAt !== null && cursorFrom(me?.settings) === null;

  if (!finished) {
    while (result.calls < MAX_SYNC_CALLS && now() - startedAt < SYNC_BUDGET_MS) {
      result.calls += 1;
      const step = await syncNow(userId, { force: true }, database, deps.sync);
      if (!step.more) break;
    }
  }

  if (now() - startedAt >= FILES_BUDGET_MS) return result;
  const queued = and(eq(jobs.userId, userId), eq(jobs.kind, SYNC_FILES_KIND), eq(jobs.status, "queued"));
  const [job] = await database.select({ id: jobs.id }).from(jobs).where(queued).limit(1);
  if (!job) return result;

  try {
    await syncFiles(userId, database, deps.files);
    result.filesListed = true;
  } catch (err) {
    // Trying again cannot help with these; the cron route ends the job the same way.
    if (!(err instanceof NotConnected || err instanceof KeyRejected || err instanceof NotAllowed)) return result;
  }
  // Only a job nobody has claimed: a running one belongs to the cron.
  await database.update(jobs).set({ status: "done" }).where(queued);
  return result;
}

/** Users whose first sync is scheduled or running in this process. */
const inFlight = new Set<string>();

export type StartFirstSyncOptions = {
  db?: Db;
  deps?: FirstSyncDeps;
  /** How the work is run later. Default: `after` from next/server. Tests pass their own. */
  schedule?: (task: () => Promise<void>) => void;
};

/**
 * Starts her first sync without waiting for it. `started: false` when one is
 * already scheduled or running for her in this process.
 */
export function startFirstSync(userId: string, opts: StartFirstSyncOptions = {}): { started: boolean } {
  if (inFlight.has(userId)) return { started: false };
  inFlight.add(userId);

  const task = async () => {
    try {
      await runFirstSync(userId, opts.db ?? defaultDb, opts.deps);
    } finally {
      inFlight.delete(userId);
    }
  };

  const schedule = opts.schedule ?? after;
  try {
    schedule(task);
  } catch {
    // Not inside a request (`after` throws there): run it now, unawaited.
    void task().catch(() => {});
  }
  return { started: true };
}

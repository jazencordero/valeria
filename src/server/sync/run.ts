/*
 * Refreshes her Moodle data when she opens the app: courses, assignments, then dates.
 *
 *   const { ran, added, status, more } = await syncNow(userId, { force: false });
 *
 * The request that runs this is cut off by the host after a fixed time, so one
 * call does only as much as fits in BUDGET_MS and says `more: true` when work
 * is left. The caller calls again until `more` is false.
 *
 * Steps, in order:
 * 1. Courses: one Moodle call (`syncCourses`).
 * 2. Assignments, a few at a time: the list is read once per call (one Moodle
 *    call for all her courses), then `syncAssignments` runs on SLICE of them
 *    at a time. Each slice asks Moodle for those hand-in statuses together
 *    and writes its rows before the next slice starts.
 * 3. Dates (`syncEvents`, ./events): her calendar and quizzes, two Moodle
 *    calls (the calendar can be up to four pages), and the exams it suggests.
 *
 * Time: the clock is checked before every step. Once BUDGET_MS have passed no
 * new step starts, so no new Moodle call starts. One exception keeps a very
 * slow Moodle from looping for ever: a call that continues an unfinished sync
 * always runs its first slice, and a call that continues with only the dates
 * left always runs that step.
 *
 * Where it was: `users.settings.syncCursor = { startedAt, done, assignmentsDone? }`,
 * where `done` holds the Moodle ids of the assignments already synced. A cursor
 * means "courses are done, the rest is not"; `assignmentsDone: true` means only
 * the dates are left. The next call skips the courses and every assignment in
 * `done` (all of them, with `assignmentsDone`), so no course is written twice
 * and no hand-in status is asked twice. The assignment list itself is read again
 * by each call (one Moodle call); it is too big to keep in the cursor.
 * A cursor older than CURSOR_MAX_AGE_MS is thrown away and the sync starts
 * over. `force` never restarts an unfinished sync, it continues it; otherwise
 * a caller that sends `force` with every call would never finish.
 *
 * Result:
 * - `ran`: false when nothing was asked of Moodle (synced under 10 minutes
 *   ago and not forced, not connected, or the key is known to be rejected).
 * - `added`: course rows plus assignment rows this call added. Event and exam
 *   rows are not counted.
 * - `status`: the connection's status after the call, or 'not_connected'.
 * - `more`: true when the caller should call again now.
 *
 * Errors become connection state:
 * - `KeyRejected`: status 'expired', the cursor is dropped. Later calls ask
 *   Moodle nothing until she connects again (`connectWithKey` sets 'ok').
 * - `MoodleDown` and every other `MoodleError`: status stays, `last_error`
 *   is saved, the cursor is kept, `last_sync_at` is not set. `more` is false
 *   so the caller stops; the next time she opens the app it tries again.
 * - Anything else is a bug and is thrown.
 * A finished sync sets `last_sync_at`, status 'ok' and clears `last_error`.
 * It also adds one `sync-files` job for her (deduped per user), which lists
 * her course files in the background (./files), and one `estimate` job for
 * each of her assignments with no `estimate_min` yet (deduped per assignment),
 * which asks the small model how long it takes (../ai/jobs/estimate; that job
 * itself skips courses not marked as allowing AI). An unfinished call adds none.
 *
 * Cut: no lock. Two calls at the same moment (two tabs) both do the same
 * slice; the rows are still written once, Moodle is asked twice.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { MOODLE_STATUSES, moodleConnections } from "@/server/db/schema/moodle";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { enqueue } from "@/server/jobs/queue";

// Same string as ESTIMATE_KIND in ../ai/jobs/estimate; written out so syncing never loads the AI router.
const ESTIMATE_KIND = "estimate";
import { KeyRejected, MoodleError } from "@/server/moodle/client";
import { getAssignments, getSubmissionStatus, type Assignment } from "@/server/moodle/read/assignments";
import { getCourses } from "@/server/moodle/read/courses";
import { getQuizzes, getUpcoming } from "@/server/moodle/read/calendar";
import { syncAssignments, type SyncAssignmentsDeps } from "./assignments";
import { NotConnected, syncCourses, type SyncCoursesDeps } from "./courses";
import { syncEvents, type SyncEventsDeps } from "./events";
import { SYNC_FILES_KIND } from "./files";

/** No new step, so no new Moodle call, starts after this much of one call. */
export const BUDGET_MS = 8_000;
/** A sync that finished less than this long ago is not repeated unless forced. */
export const FRESH_MS = 10 * 60 * 1000;
/** An unfinished sync older than this is started over instead of continued. */
export const CURSOR_MAX_AGE_MS = 10 * 60 * 1000;
/** Assignments per step. The same number `syncAssignments` asks statuses for at once, so a step is one round of calls. */
export const SLICE = 4;
/** The key in `users.settings` that holds the cursor. */
export const CURSOR_KEY = "syncCursor";

const LAST_ERROR_MAX = 300;

export type MoodleStatus = (typeof MOODLE_STATUSES)[number];

export type SyncNowOptions = { force?: boolean };

export type SyncNowResult = {
  ran: boolean;
  added: number;
  status: MoodleStatus | "not_connected";
  more: boolean;
};

/** What the sync reads Moodle and the clock with. Tests pass their own. */
export type SyncNowDeps = SyncCoursesDeps & SyncAssignmentsDeps & SyncEventsDeps;

export type SyncCursor = {
  /** When the sync this cursor belongs to started (ms). */
  startedAt: number;
  /** Moodle ids of the assignments already synced. */
  done: number[];
  /** Every assignment is synced; only the dates are left. Left out when false. */
  assignmentsDone?: true;
};

const defaultDeps: SyncNowDeps = {
  getCourses,
  getAssignments,
  getSubmissionStatus,
  getUpcoming,
  getQuizzes,
  now: () => Date.now(),
};

/** The cursor saved in `settings`, or null when there is none or it is not one. */
export function cursorFrom(settings: Record<string, unknown> | null | undefined): SyncCursor | null {
  const raw = settings?.[CURSOR_KEY] as
    | { startedAt?: unknown; done?: unknown; assignmentsDone?: unknown }
    | null
    | undefined;
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.startedAt !== "number" || !Number.isFinite(raw.startedAt)) return null;
  if (!Array.isArray(raw.done) || !raw.done.every((id) => Number.isSafeInteger(id))) return null;
  const cursor: SyncCursor = { startedAt: raw.startedAt, done: raw.done as number[] };
  if (raw.assignmentsDone === true) cursor.assignmentsDone = true;
  return cursor;
}

// Only the cursor's own key is written: users.settings also holds other things
// (the Moodle client's daily call count), which must not be overwritten.
async function saveCursor(database: Db, userId: string, cursor: SyncCursor): Promise<void> {
  await database
    .update(users)
    .set({ settings: sql`jsonb_set(${users.settings}, ${`{${CURSOR_KEY}}`}::text[], ${JSON.stringify(cursor)}::jsonb)` })
    .where(eq(users.id, userId));
}

async function clearCursor(database: Db, userId: string): Promise<void> {
  await database
    .update(users)
    .set({ settings: sql`${users.settings} - ${CURSOR_KEY}::text` })
    .where(eq(users.id, userId));
}

export async function syncNow(
  userId: string,
  opts: SyncNowOptions = {},
  database: Db = defaultDb,
  deps: SyncNowDeps = defaultDeps,
): Promise<SyncNowResult> {
  const callStartedAt = deps.now();
  const outOfTime = () => deps.now() - callStartedAt >= BUDGET_MS;

  const [link] = await database
    .select({ status: moodleConnections.status, lastSyncAt: moodleConnections.lastSyncAt })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);
  if (!link) return { ran: false, added: 0, status: "not_connected", more: false };
  // A key Moodle has rejected is not tried again; she has to connect again.
  if (link.status === "expired" || link.status === "revoked") {
    return { ran: false, added: 0, status: link.status, more: false };
  }

  const [me] = await database.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).limit(1);
  let cursor = cursorFrom(me?.settings);
  if (cursor && callStartedAt - cursor.startedAt >= CURSOR_MAX_AGE_MS) cursor = null;

  if (!cursor && !opts.force && link.lastSyncAt && callStartedAt - link.lastSyncAt.getTime() < FRESH_MS) {
    return { ran: false, added: 0, status: link.status, more: false };
  }

  const syncStartedAt = cursor?.startedAt ?? callStartedAt;
  const done = new Set(cursor?.done ?? []);
  let assignmentsDone = cursor?.assignmentsDone === true;
  const cursorNow = (): SyncCursor => ({
    startedAt: syncStartedAt,
    done: [...done],
    ...(assignmentsDone ? { assignmentsDone: true as const } : {}),
  });
  let coursesDone = cursor !== null;
  let added = 0;

  try {
    if (!coursesDone) {
      added += (await syncCourses(userId, database, { getCourses: deps.getCourses })).added;
      coursesDone = true;
      if (outOfTime()) {
        await saveCursor(database, userId, cursorNow());
        return { ran: true, added, status: link.status, more: true };
      }
    }

    // `syncAssignments` is run on one slice at a time: it is handed the next
    // few assignments instead of the whole list, and nothing once time is up.
    let list: Assignment[] | null = null;
    let slice: Assignment[] = [];
    // The first slice of a call that continues a sync runs even when the list
    // read used up the time, so every call gets somewhere.
    let mayStop = cursor === null;
    const left = () => (list ?? []).filter((a) => !done.has(a.moodleId));
    const sliceDeps: SyncAssignmentsDeps = {
      getAssignments: async (conn, courseIds) => {
        if (list === null) {
          const seen = new Map<number, Assignment>();
          for (const a of await deps.getAssignments(conn, courseIds)) {
            if (!seen.has(a.moodleId)) seen.set(a.moodleId, a);
          }
          list = [...seen.values()];
        }
        slice = mayStop && outOfTime() ? [] : left().slice(0, SLICE);
        return slice;
      },
      getSubmissionStatus: deps.getSubmissionStatus,
    };

    while (!assignmentsDone) {
      slice = [];
      added += (await syncAssignments(userId, database, sliceDeps)).added;
      for (const a of slice) done.add(a.moodleId);
      if (left().length === 0) {
        assignmentsDone = true;
        break;
      }
      if (slice.length === 0) {
        // Time is up and assignments are left.
        await saveCursor(database, userId, cursorNow());
        return { ran: true, added, status: link.status, more: true };
      }
      mayStop = true;
    }

    // Dates (M3-12). Skipped for the next call when time is up, unless this
    // call continued a sync with only the dates left: then it is all it does.
    if (!cursor?.assignmentsDone && outOfTime()) {
      await saveCursor(database, userId, cursorNow());
      return { ran: true, added, status: link.status, more: true };
    }
    await syncEvents(userId, database, { getUpcoming: deps.getUpcoming, getQuizzes: deps.getQuizzes, now: deps.now });

    // Her course files are listed in the background (./files, M2-08): one
    // `sync-files` job per user, so a sync that finishes while the last job
    // still waits adds nothing. Added before the sync is marked finished: if
    // this fails, the cursor is still there and the next call tries again.
    await enqueue(SYNC_FILES_KIND, {}, { userId, dedupeKey: userId, db: database, now: () => new Date(deps.now()) });

    // How long each assignment takes (M2-12): one `estimate` job per assignment
    // that has none, deduped per assignment, so a job still waiting is not doubled.
    const unestimated = await database
      .select({ id: assignments.id })
      .from(assignments)
      .where(and(eq(assignments.userId, userId), isNull(assignments.estimateMin)));
    for (const { id } of unestimated) {
      await enqueue(ESTIMATE_KIND, { assignmentId: id }, { userId, dedupeKey: id, db: database, now: () => new Date(deps.now()) });
    }

    await database
      .update(moodleConnections)
      .set({ status: "ok", lastSyncAt: new Date(deps.now()), lastError: null })
      .where(eq(moodleConnections.userId, userId));
    await clearCursor(database, userId);
    return { ran: true, added, status: "ok", more: false };
  } catch (err) {
    if (err instanceof NotConnected) {
      // She disconnected while this ran.
      return { ran: false, added, status: "not_connected", more: false };
    }
    if (!(err instanceof MoodleError)) throw err;
    // Moodle error messages never hold her key (see ../moodle/client).
    const lastError = `${err.name}: ${err.message}`.slice(0, LAST_ERROR_MAX);
    if (err instanceof KeyRejected) {
      await database
        .update(moodleConnections)
        .set({ status: "expired", lastError })
        .where(eq(moodleConnections.userId, userId));
      await clearCursor(database, userId);
      return { ran: true, added, status: "expired", more: false };
    }
    await database.update(moodleConnections).set({ lastError }).where(eq(moodleConnections.userId, userId));
    if (coursesDone) await saveCursor(database, userId, cursorNow());
    return { ran: true, added, status: link.status, more: false };
  }
}

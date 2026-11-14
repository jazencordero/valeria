/*
 * Demo account for testers and tests (M1-37).
 *
 *   await openDemo(user, { reset });   // what GET /demo does
 *   await seedDemo(userId);            // fill one user with the sample data
 *
 * A demo user is an ordinary device-session user with `users.settings.demo`
 * set to true. `seedDemo` fills it through the real code path: a
 * `moodle_connections` row holding the fake Moodle's key, then `syncNow` (the
 * same course and assignment sync a real user gets), answered in-process by
 * the fake Moodle (`MOODLE_FAKE=1`, ../moodle/fake-inline) from
 * `tests/fixtures/moodle-sample/`.
 *
 * Due dates follow the prototype's week instead of the sample's fixed dates.
 * The sample's assignments, in the order they fall due, get (Europe/Helsinki):
 *   1st (Assignment 3)        today      21:00
 *   2nd (Case memo 2)         today + 3  23:59   (prototype: "TUE 17 · 23:59")
 *   3rd (Service blueprint)   today + 5  16:00   (prototype: "THU 19 · 16:00")
 * The prototype's "today" is Saturday 14 November, so +3 and +5 are its
 * Tuesday and Thursday. A cut-off or open date moves by the same amount as its
 * due date. More than three assignments: the rest move like the third.
 *
 * Keeping the shifted dates: the sync on Home (not forced, every 10 minutes)
 * would write the sample's fixed dates back. So the demo connection's
 * `last_sync_at` is set a year ahead, which the sync reads as "just synced".
 * A forced sync (POST /api/sync with force) still writes the sample's dates;
 * /demo?reset=1 shifts them again.
 *
 * No `identities` row is written: every fake user is the same Moodle user
 * (4242), and an identity would make the next demo browser merge into this one.
 *
 * Safety:
 * - Nothing here runs unless `demoAllowed()`: MOODLE_FAKE=1 and not Vercel
 *   production (the fake Moodle refuses production too). Otherwise it throws
 *   `DemoUnavailable`, and GET /demo answers 404 without touching anything.
 * - Only a user that is already a demo user, or one with nothing in it (no
 *   Moodle connection, no courses, no assignments), is ever seeded. Any
 *   other user is refused (`has_own_data`) and left exactly as it was.
 * - Reset wipes only a demo user: a fresh demo user takes over this browser's
 *   session, and the old one is deleted with everything in it (on delete
 *   cascade, the same way settings' "delete everything" works). The fake
 *   Moodle's memory of the old user's hand-ins is dropped too (`resetFake`).
 */
import { getQuizzes, getUpcoming } from "@/server/moodle/read/calendar";
import { eq, sql } from "drizzle-orm";
import { SCHOOLS } from "@/lib/schools";
import type { User } from "@/server/auth/session";
import { seal } from "@/server/crypto/seal";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { sessions, users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { DEMO_KEY, resetFake } from "@/server/moodle/fake-inline";
import { getAssignments, getSubmissionStatus, type Assignment } from "@/server/moodle/read/assignments";
import { getCourses } from "@/server/moodle/read/courses";
import { getSiteInfo } from "@/server/moodle/read/site";
import { syncNow, type SyncNowDeps } from "@/server/sync/run";

/** The key in `users.settings` that marks a demo user. */
export const DEMO_FLAG = "demo";
/** The clock the demo's "today" is read on. */
export const DEMO_ZONE = "Europe/Helsinki";
/** The site the demo connection names, so the app names the school's LMS. */
export const DEMO_SITE = SCHOOLS.aalto.siteUrl;

/** Days after today and wall-clock time, in the order the sample's assignments fall due. */
export const DEMO_WEEK = [
  { days: 0, hour: 21, minute: 0 },
  { days: 3, hour: 23, minute: 59 },
  { days: 5, hour: 16, minute: 0 },
] as const;

/** How far ahead `last_sync_at` is put, so Home's sync leaves the shifted dates alone. */
const FROZEN_FOR_MS = 365 * 24 * 60 * 60 * 1000;
/** `syncNow` steps one seed may take; the sample needs one or two. */
const MAX_SYNC_STEPS = 10;

export class DemoUnavailable extends Error {
  constructor() {
    super("The demo needs the fake Moodle (MOODLE_FAKE=1) and never runs in production.");
    this.name = "DemoUnavailable";
  }
}

/** Whether demo data may be written here: the fake Moodle is on and this is not production. */
export function demoAllowed(): boolean {
  return process.env.MOODLE_FAKE === "1" && process.env.VERCEL_ENV !== "production";
}

function guard(): void {
  if (!demoAllowed()) throw new DemoUnavailable();
}

/** Whether this user (or its settings) is a demo user. */
export function isDemo(user: Pick<User, "settings"> | null | undefined): boolean {
  return user?.settings?.[DEMO_FLAG] === true;
}

// ---------------------------------------------------------------------------
// Dates.

function zoneParts(at: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** How far `zone`'s wall clock is ahead of UTC at `at`, in ms. */
function zoneOffsetMs(at: Date, zone: string): number {
  const p = zoneParts(at, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant `zone`'s wall clock shows this date and time (day may overflow the month). */
function wallTime(zone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMs(new Date(guess), zone);
  // Once more at the found instant, for a day when the clocks change.
  return new Date(guess - zoneOffsetMs(new Date(first), zone));
}

/** The demo's due dates for `now`: one per `DEMO_WEEK` entry, today being `now`'s day in Helsinki. */
export function demoDueDates(now: Date = new Date()): Date[] {
  const today = zoneParts(now, DEMO_ZONE);
  return DEMO_WEEK.map((w) => wallTime(DEMO_ZONE, today.year, today.month, today.day + w.days, w.hour, w.minute));
}

const moveBy = (d: Date | null, ms: number) => (d ? new Date(d.getTime() + ms) : null);

/** The sample's assignments with their dates moved onto the demo week. */
export function shiftToDemoWeek(list: Assignment[], now: Date): Assignment[] {
  const due = demoDueDates(now);
  const order = [...list]
    .filter((a) => a.dueAt)
    .sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime() || a.moodleId - b.moodleId);
  const deltaOf = new Map<number, number>();
  order.forEach((a, i) => {
    const target = due[Math.min(i, due.length - 1)];
    deltaOf.set(a.moodleId, target.getTime() - a.dueAt!.getTime());
  });
  // The ones after the last DEMO_WEEK entry keep their distance to it.
  const lastIdx = Math.min(order.length, due.length) - 1;
  if (lastIdx >= 0) {
    const anchor = order[lastIdx];
    const anchorDelta = deltaOf.get(anchor.moodleId)!;
    for (const a of order.slice(due.length)) deltaOf.set(a.moodleId, anchorDelta);
  }
  return list.map((a) => {
    const delta = deltaOf.get(a.moodleId);
    if (delta === undefined) return a;
    return { ...a, dueAt: moveBy(a.dueAt, delta), cutoffAt: moveBy(a.cutoffAt, delta), opensAt: moveBy(a.opensAt, delta) };
  });
}

// ---------------------------------------------------------------------------
// Seeding.

export type SeedOptions = { now?: Date };
export type SeedResult = { userId: string; assignments: number };

async function markDemo(database: Db, userId: string): Promise<void> {
  await database
    .update(users)
    .set({ settings: sql`jsonb_set(${users.settings}, ${`{${DEMO_FLAG}}`}::text[], 'true'::jsonb)` })
    .where(eq(users.id, userId));
}

/**
 * Fills `userId` with the sample courses and assignments through the real
 * sync, dates moved onto the demo week, and marks it a demo user. Does not
 * check what the user already holds; `openDemo` does that.
 */
export async function seedDemo(userId: string, database: Db = defaultDb, opts: SeedOptions = {}): Promise<SeedResult> {
  guard();
  const now = opts.now ?? new Date();
  await markDemo(database, userId);

  // The same check the connect screen does, answered by the fake.
  const info = await getSiteInfo({ siteUrl: DEMO_SITE, token: DEMO_KEY, userId });
  const values = {
    siteUrl: DEMO_SITE,
    moodleUserId: info.userId,
    tokenSealed: seal(DEMO_KEY),
    functions: info.functions,
    status: "ok" as const,
    connectedAt: now,
    lastSyncAt: null,
    lastError: null,
  };
  await database
    .insert(moodleConnections)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: moodleConnections.userId, set: values });

  const deps: SyncNowDeps = {
    getCourses,
    getAssignments: async (conn, courseIds) => shiftToDemoWeek(await getAssignments(conn, courseIds), now),
    getSubmissionStatus,
    getUpcoming,
    getQuizzes,
    now: () => Date.now(),
  };
  for (let step = 0; step < MAX_SYNC_STEPS; step++) {
    const result = await syncNow(userId, { force: true }, database, deps);
    if (result.status !== "ok") throw new Error(`Demo sync stopped: ${result.status}`);
    if (!result.more) break;
  }

  await database
    .update(moodleConnections)
    .set({ lastSyncAt: new Date(Date.now() + FROZEN_FOR_MS) })
    .where(eq(moodleConnections.userId, userId));

  const rows = await database.select({ id: assignments.id }).from(assignments).where(eq(assignments.userId, userId));
  return { userId, assignments: rows.length };
}

/**
 * Wipes a demo user and seeds a fresh one in its place on the same sessions
 * (this browser keeps its cookie). Returns the new user's id. Refuses (throws)
 * for a user that is not a demo user, and changes nothing then.
 */
export async function resetDemo(userId: string, database: Db = defaultDb, opts: SeedOptions = {}): Promise<SeedResult> {
  guard();
  const freshId = await database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [old] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!old || !isDemo(old)) throw new Error("resetDemo: not a demo user; nothing was changed.");
    const [fresh] = await tx
      .insert(users)
      .values({ displayName: old.displayName, school: old.school, settings: { [DEMO_FLAG]: true } })
      .returning({ id: users.id });
    await tx.update(sessions).set({ userId: fresh.id }).where(eq(sessions.userId, userId));
    // Everything she had goes with the row (on delete cascade).
    await tx.delete(users).where(eq(users.id, userId));
    return fresh.id;
  });
  resetFake(userId);
  return seedDemo(freshId, database, opts);
}

export type OpenDemoResult =
  | { ok: true; userId: string; seeded: boolean }
  | { ok: false; reason: "has_own_data" };

/** Whether a non-demo user holds anything: a Moodle connection, a course or an assignment. */
async function hasOwnData(database: Db, userId: string): Promise<boolean> {
  const checks = await Promise.all([
    database.select({ id: moodleConnections.id }).from(moodleConnections).where(eq(moodleConnections.userId, userId)).limit(1),
    database.select({ id: courses.id }).from(courses).where(eq(courses.userId, userId)).limit(1),
    database.select({ id: assignments.id }).from(assignments).where(eq(assignments.userId, userId)).limit(1),
  ]);
  return checks.some((rows) => rows.length > 0);
}

/**
 * GET /demo for this browser's user:
 * - a demo user: `reset` wipes and reseeds; otherwise it is seeded only if it
 *   holds no assignments (a seed that stopped half way), else kept as it is;
 * - an empty user: becomes a demo user and is seeded;
 * - a user with data of its own: refused, nothing changes.
 */
export async function openDemo(
  user: Pick<User, "id" | "settings">,
  opts: { reset?: boolean; now?: Date } = {},
  database: Db = defaultDb,
): Promise<OpenDemoResult> {
  guard();
  if (isDemo(user)) {
    if (opts.reset) {
      const r = await resetDemo(user.id, database, { now: opts.now });
      return { ok: true, userId: r.userId, seeded: true };
    }
    const [any] = await database
      .select({ id: assignments.id })
      .from(assignments)
      .where(eq(assignments.userId, user.id))
      .limit(1);
    if (any) return { ok: true, userId: user.id, seeded: false };
    await seedDemo(user.id, database, { now: opts.now });
    return { ok: true, userId: user.id, seeded: true };
  }
  if (await hasOwnData(database, user.id)) return { ok: false, reason: "has_own_data" };
  await seedDemo(user.id, database, { now: opts.now });
  return { ok: true, userId: user.id, seeded: true };
}

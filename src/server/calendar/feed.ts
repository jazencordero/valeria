/*
 * M7-02: her private calendar link. Calendar apps subscribe to it and refresh on their own
 * schedule (hours); we never get access to her calendar.
 *
 *   const { link } = await createFeed(userId, "google", { origin });   // shown once
 *   subscribeLinks(link)                                              // google / apple / outlook
 *   await itemsForToken(token)                                        // null: unknown or revoked
 *   await revokeFeed(userId)
 *
 * The token:
 * - 32 random bytes, base64url (43 characters). Only its SHA-256 (hex) is stored, in
 *   `calendar_feeds.token_hash`; the raw token exists only in the link returned once by
 *   `createFeed`. Nothing here logs the token or the link.
 * - Lookup is by hash (the unique index), never by the raw token, so the database never sees
 *   it. The stored hash is compared again with `timingSafeEqual` before it is trusted.
 * - A string that is not 43 base64url characters is rejected before any query.
 *
 * One feed per user (`calendar_feeds.user_id` is unique): `createFeed` replaces her feed, so a
 * new link revokes the old one. `revokeFeed` deletes the row; the next fetch of the old link
 * is a 404.
 *
 * Where the link's address comes from, first that is set:
 * 1. `options.origin`: the caller passes the origin of the request she made (e.g. from the
 *    settings action), so a preview deployment hands out links to itself.
 * 2. `APP_URL` (optional, e.g. `https://ready.example`).
 * 3. `VERCEL_PROJECT_PRODUCTION_URL` (set by Vercel, a host without a scheme).
 * 4. `http://localhost:3000`.
 * The link is `<origin>/api/cal/<token>.ics`; the route also answers without `.ics`.
 *
 * What the feed lists (`itemsForToken`), only rows of the feed's user, never of a hidden course:
 * - Deadlines: her assignments that are still to do (state `open` or `draft`) and have a due
 *   date. Handed-in (`submitted`) and `graded` ones are left out: nothing to do any more.
 * - Exams: every `exams` row (kind `exam` or `quiz`), with the title and time she may have
 *   changed herself.
 * - Other dates from `events`, except where another row already says it: an event an exam
 *   links to (the exam is listed instead), a Moodle `deadline` event (Moodle's calendar copy of
 *   an assignment, which the assignment row covers and knows whether it is handed in), a
 *   `deadline` event of any source at the very time one of her assignments in the same course is
 *   due (a hand-made account file lists the calendar's copy of each assignment as its own entry:
 *   without this every deadline, and every reminder for it, comes twice), and `other` events
 *   (not a deadline, exam or quiz).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { CalendarItem } from "@/lib/ics";
import { db as defaultDb, type Db } from "@/server/db/client";
import { calendarFeeds, events } from "@/server/db/schema/calendar";
import { courses } from "@/server/db/schema/courses";
import { exams } from "@/server/db/schema/study";
import { assignments } from "@/server/db/schema/work";
import { helsinkiDay } from "@/server/study/start-date";

export const FEED_PROVIDERS = ["google", "apple", "outlook"] as const;
export type FeedProvider = (typeof FEED_PROVIDERS)[number];

/** The name calendar apps show for the subscribed calendar. */
export const CALENDAR_NAME = "Ready";

const TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const FEED_PATH = "/api/cal/";
const FALLBACK_ORIGIN = "http://localhost:3000";

export class UnknownProvider extends Error {
  constructor() {
    super("Unknown calendar provider.");
  }
}

/** SHA-256 of the token, hex. This is what `calendar_feeds.token_hash` holds. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** True when the string has the shape of one of our tokens. */
export function isTokenShape(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

function baseOrigin(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.APP_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`,
  ];
  for (const value of candidates) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // not a URL: try the next one
    }
  }
  return FALLBACK_ORIGIN;
}

export type CreateFeedOptions = { origin?: string; db?: Db };

/**
 * Makes her a new private link and returns it. This is the only time the link exists outside
 * her calendar app: show it, do not store it. Replaces (and so revokes) any link she had.
 */
export async function createFeed(
  userId: string,
  provider: FeedProvider,
  options: CreateFeedOptions = {},
): Promise<{ link: string }> {
  if (!(FEED_PROVIDERS as readonly string[]).includes(provider)) throw new UnknownProvider();
  const database = options.db ?? defaultDb;
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(token);
  await database
    .insert(calendarFeeds)
    .values({ userId, tokenHash, provider })
    .onConflictDoUpdate({ target: calendarFeeds.userId, set: { tokenHash, provider } });
  return { link: `${baseOrigin(options.origin)}${FEED_PATH}${token}.ics` };
}

/** Stops her link working. Does nothing when she has none. */
export async function revokeFeed(userId: string, database: Db = defaultDb): Promise<void> {
  await database.delete(calendarFeeds).where(eq(calendarFeeds.userId, userId));
}

/** The user a token belongs to, or null for a malformed, unknown or revoked token. */
export async function userForToken(token: string, database: Db = defaultDb): Promise<string | null> {
  if (!isTokenShape(token)) return null;
  const wanted = hashToken(token);
  const [row] = await database
    .select({ userId: calendarFeeds.userId, tokenHash: calendarFeeds.tokenHash })
    .from(calendarFeeds)
    .where(eq(calendarFeeds.tokenHash, wanted))
    .limit(1);
  if (!row) return null;
  const a = Buffer.from(row.tokenHash, "utf8");
  const b = Buffer.from(wanted, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return row.userId;
}

function courseLabel(c: { code: string | null; shortName: string | null; name: string | null }): string {
  return c.code?.trim() || c.shortName?.trim() || c.name?.trim() || "";
}

/** What the feed of one user lists. See the rules in the file header. */
export async function itemsForUser(userId: string, database: Db = defaultDb): Promise<CalendarItem[]> {
  const deadlines = await database
    .select({
      id: assignments.id,
      title: assignments.name,
      at: assignments.dueAt,
      code: courses.code,
      shortName: courses.shortName,
      name: courses.name,
    })
    .from(assignments)
    .innerJoin(courses, eq(courses.id, assignments.courseId))
    .where(
      and(
        eq(assignments.userId, userId),
        eq(courses.hidden, false),
        isNotNull(assignments.dueAt),
        inArray(assignments.state, ["open", "draft"]),
      ),
    );

  const examRows = await database
    .select({
      id: exams.id,
      kind: exams.kind,
      title: exams.title,
      at: exams.at,
      wholeDay: exams.timeIsPlaceholder,
      eventId: exams.eventId,
      code: courses.code,
      shortName: courses.shortName,
      name: courses.name,
    })
    .from(exams)
    .innerJoin(courses, eq(courses.id, exams.courseId))
    .where(and(eq(exams.userId, userId), eq(courses.hidden, false)));

  // Every exam of hers that links an event, hidden course or not, so its event is never listed twice.
  const linked = await database
    .select({ eventId: exams.eventId })
    .from(exams)
    .where(and(eq(exams.userId, userId), isNotNull(exams.eventId)));
  const covered = new Set(linked.map((row) => row.eventId));

  // Every dated assignment of hers, handed in or not: a deadline event at the same time in the
  // same course is that assignment's calendar copy.
  const dueTimes = await database
    .select({ courseId: assignments.courseId, at: assignments.dueAt })
    .from(assignments)
    .where(and(eq(assignments.userId, userId), isNotNull(assignments.dueAt)));
  const assignmentAt = new Set(dueTimes.map((a) => `${a.courseId}|${a.at?.getTime()}`));

  const eventRows = await database
    .select({
      id: events.id,
      courseId: events.courseId,
      kind: events.kind,
      source: events.source,
      title: events.title,
      at: events.startsAt,
      code: courses.code,
      shortName: courses.shortName,
      name: courses.name,
      hidden: courses.hidden,
    })
    .from(events)
    .leftJoin(courses, eq(courses.id, events.courseId))
    .where(
      and(
        eq(events.userId, userId),
        inArray(events.kind, ["deadline", "exam", "quiz"]),
        or(isNull(events.courseId), eq(courses.hidden, false)),
      ),
    );

  const items: CalendarItem[] = [];
  for (const a of deadlines) {
    if (!a.at) continue;
    items.push({ id: a.id, kind: "deadline", title: a.title, course: courseLabel(a), at: a.at });
  }
  for (const e of examRows) {
    // An exam whose clock time is a placeholder is an all-day entry on its Helsinki day.
    items.push({
      id: e.id,
      kind: e.kind,
      title: e.title,
      course: courseLabel(e),
      at: e.at,
      ...(e.wholeDay ? { allDay: helsinkiDay(e.at) } : {}),
    });
  }
  for (const e of eventRows) {
    if (covered.has(e.id)) continue;
    if (e.kind === "deadline" && e.source === "moodle") continue;
    if (e.kind === "deadline" && e.courseId && assignmentAt.has(`${e.courseId}|${e.at.getTime()}`)) continue;
    if (e.kind === "other") continue;
    items.push({ id: e.id, kind: e.kind, title: e.title, course: courseLabel(e), at: e.at });
  }
  return items;
}

/** The items of the token's user, or null for a malformed, unknown or revoked token. */
export async function itemsForToken(token: string, database: Db = defaultDb): Promise<CalendarItem[] | null> {
  const userId = await userForToken(token, database);
  if (!userId) return null;
  return itemsForUser(userId, database);
}

/**
 * Where each calendar app subscribes to the link (checked 2026-11-15):
 * - Google: `https://calendar.google.com/calendar/render?cid=<webcal link, URI-encoded>`.
 *   Not documented by Google, but the long-standing form; it opens "Add calendar?".
 * - Apple: the link with `webcal://`; Calendar on iPhone and Mac offers to subscribe.
 * - Outlook (personal accounts): `https://outlook.live.com/calendar/0/addfromweb?url=<link>&name=Ready`.
 *   Not documented by Microsoft either; "Subscribe from web" by hand works the same.
 */
export function subscribeLinks(link: string): Record<FeedProvider, string> {
  const url = new URL(link);
  const https = url.toString();
  const webcal = `webcal://${url.host}${url.pathname}${url.search}`;
  return {
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`,
    apple: webcal,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent(CALENDAR_NAME)}`,
  };
}

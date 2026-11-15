import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { startOfDay } from "@/lib/dates";
import { dueReminders, helsinkiDay, isNudgeHour, nudge, type NudgeExam, type Reminder } from "@/lib/remind/plan";
import { itemsForUser } from "@/server/calendar/feed";
import { examNotPast } from "@/server/data/exams";
import { db, type Db } from "@/server/db/client";
import { pushSubscriptions, reminderLog } from "@/server/db/schema/calendar";
import { courses } from "@/server/db/schema/courses";
import { exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { drain } from "@/server/jobs/queue";
import { sendPush, vapidConfig } from "@/server/push/send";
import { loadDeck } from "@/server/study/store";

// Drains the `remind` job kind (M7-07). The hourly tick (../tick/route.ts)
// queues one `remind` job per hour; each job is one pass over every user:
// what `dueReminders` and `nudge` (src/lib/remind/plan.ts) say is due now goes
// out by push (`sendPush`, M7-06) and is written to `reminder_log`. Email
// reminders wait for M7-09.
//
// Called by the tick as POST with `Authorization: Bearer <CRON_SECRET>`.
// Without CRON_SECRET in the environment every request gets 401: the route is
// never open. The secret is not logged or echoed anywhere.
//
// Who gets reminders:
// - Users with at least one device that turned "Notifications on this phone"
//   on (a `push_subscriptions` row). Push is the only channel, so nobody else
//   could receive anything.
// - Reminders are on by default for them: subscribing a phone is the opt-in.
//   They are off when `users.settings.reminders` is `false`, `null` or
//   `"none"` (the values the never-miss card uses for "off").
// - Demo users (`users.settings.demo === true`, see src/server/demo/seed.ts)
//   are skipped.
//
// What is sent:
// - Deadlines and exams from `itemsForUser` (src/server/calendar/feed.ts):
//   assignments still to do, her exams and quizzes, other dated events; never
//   a hidden course. Handed-in work is not in that list, so it gets nothing.
// - The nudge only during its hour (17:00 Helsinki), from her exams and
//   quizzes that have not started, in courses that are not hidden, with each
//   deck loaded by `loadDeck` (active cards only).
//
// Never twice, even if two passes run at once: before sending, the reminder's
// `reminder_log` row is inserted (unique on user, ref, kind; ref is the item
// id, or the Helsinki day for the nudge); a pass that finds the row already
// there sends nothing. If the push reaches no device (none left, or every
// push service failed), the row is deleted again, so the next pass within the
// reminder's hour may try again; after that hour it is dropped.
//
// Push not set up (no VAPID keys, `vapidConfig()` is null): the pass does
// nothing and logs nothing. Nothing piles up for later either: once keys
// exist, only reminders due in that hour are sent, never a backlog.
//
// Answer: { ok, done, retried, failed, configured, users, sent, nudges,
// unsent, errors }. `done`, `retried`, `failed` are what `drain` says.
// `users` counts the users looked at, `sent` the reminders and `nudges` the
// nudges that reached a device, `unsent` those that reached none, `errors`
// users whose pass threw (counted, not logged: an error can carry database
// details; the next pass tries again). Nothing here logs at all.
//
// Time: one job is one pass; no user is started after BUDGET_MS. Set as
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md says.
export const maxDuration = 300;
// No `dynamic` export: this app uses `cacheComponents`, which forbids it, and a
// handler that reads the request's headers is never prerendered anyway.

const REMIND_KIND = "remind";
const BUDGET_MS = 150_000;
/** A pass is cheap to repeat; more than this many queued jobs means a backlog, not more work. */
const MAX_JOBS = 3;

/** True when the request carries the cron secret. Compared in constant time. */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  // Hashing first gives both sides the same length, which timingSafeEqual
  // needs, and so the comparison leaks neither the secret nor its length.
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

type Tally = { users: number; sent: number; nudges: number; unsent: number; errors: number };

/** Reminders are on unless she turned them off (see the header). */
function remindersOn(settings: Record<string, unknown>): boolean {
  if (!("reminders" in settings)) return true;
  const value = settings.reminders;
  return !(value === false || value === null || value === "none");
}

/** The last millisecond of the Helsinki day of `at`. */
function endOfDay(at: Date): Date {
  // Noon the next day is always inside the next Helsinki day, whatever the clocks did.
  return new Date(startOfDay(new Date(startOfDay(at).getTime() + 36 * 60 * 60 * 1000)).getTime() - 1);
}

/** Her exams and quizzes that have not started, in courses she has not hidden, each with its deck. */
async function nudgeExams(userId: string, now: Date, database: Db): Promise<NudgeExam[]> {
  const rows = await database
    .select({ id: exams.id, title: exams.title, at: exams.at, wholeDay: exams.timeIsPlaceholder })
    .from(exams)
    .innerJoin(courses, eq(courses.id, exams.courseId))
    .where(and(eq(exams.userId, userId), eq(courses.hidden, false), examNotPast(now)));
  const out: NudgeExam[] = [];
  for (const row of rows) {
    // A whole-day exam (its clock time is a stand-in) is still ahead all of its Helsinki day, so
    // the 17:00 nudge on that day counts it: it is aimed at the end of the day.
    const exam = { id: row.id, title: row.title, at: row.wholeDay ? endOfDay(row.at) : row.at };
    const deck = await loadDeck(userId, exam.id, database);
    out.push({ exam, concepts: deck.concepts, cards: deck.cards });
  }
  return out;
}

/** Claims the log row, sends, and gives the row back when nothing arrived. True when it arrived. */
async function deliver(userId: string, reminder: Reminder, database: Db): Promise<boolean | null> {
  const claimed = await database
    .insert(reminderLog)
    .values({ userId, ref: reminder.ref, kind: reminder.kind })
    .onConflictDoNothing()
    .returning({ id: reminderLog.id });
  if (claimed.length === 0) return null; // another pass sent it already

  let arrived = false;
  try {
    const result = await sendPush(userId, { title: reminder.title, body: reminder.body, url: reminder.url }, { db: database });
    arrived = result.status === "sent" && result.sent > 0;
  } finally {
    if (!arrived) await database.delete(reminderLog).where(eq(reminderLog.id, claimed[0].id));
  }
  return arrived;
}

async function remindUser(userId: string, now: Date, database: Db, tally: Tally): Promise<void> {
  const items = await itemsForUser(userId, database);
  const log = await database
    .select({ ref: reminderLog.ref, kind: reminderLog.kind })
    .from(reminderLog)
    .where(eq(reminderLog.userId, userId));

  const due = dueReminders(items, now, log);
  if (isNudgeHour(now)) {
    const sentToday = log.some((e) => e.kind === "nudge" && e.ref === helsinkiDay(now));
    const daily = nudge(await nudgeExams(userId, now, database), now, sentToday);
    if (daily) due.push(daily);
  }

  for (const reminder of due) {
    const arrived = await deliver(userId, reminder, database);
    if (arrived === null) continue;
    if (!arrived) tally.unsent += 1;
    else if (reminder.kind === "nudge") tally.nudges += 1;
    else tally.sent += 1;
  }
}

/** One pass over every user who could get a reminder now. */
async function pass(now: Date, database: Db, tally: Tally, started: number): Promise<void> {
  const rows = await database
    .selectDistinct({ id: users.id, settings: users.settings })
    .from(users)
    .innerJoin(pushSubscriptions, eq(pushSubscriptions.userId, users.id));

  for (const user of rows) {
    if (Date.now() - started > BUDGET_MS) break;
    const settings = user.settings ?? {};
    if (settings.demo === true || !remindersOn(settings)) continue;
    tally.users += 1;
    try {
      await remindUser(user.id, now, database, tally);
    } catch {
      tally.errors += 1;
    }
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const configured = vapidConfig() !== null;
  const tally: Tally = { users: 0, sent: 0, nudges: 0, unsent: 0, errors: 0 };
  const started = Date.now();
  let passed = false;

  const result = await drain(
    REMIND_KIND,
    async () => {
      // Several queued jobs (ticks that could not reach this route) need one pass, not several.
      if (passed || !configured) return;
      passed = true;
      await pass(new Date(), db, tally, started);
    },
    { max: MAX_JOBS, budgetMs: BUDGET_MS },
  );

  return Response.json({ ok: result.failed === 0, ...result, configured, ...tally });
}

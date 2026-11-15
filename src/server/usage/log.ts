/*
 * The usage log behind two of the three success signals (M8-28):
 * "she opens it 3 times a week unprompted" and "opening to studying takes
 * under 10 seconds". Rows go to `usage_events` in our own database and
 * nowhere else; no third-party analytics.
 *
 *   await logEvent(user.id, "open");            // first page view of a visit
 *   await logEvent(user.id, "start");           // ms since that visit's open
 *   await logEvent(user.id, "start", 4200);     // ms measured by the caller
 *   await logEvent(user.id, "hand_in");
 *
 * Kinds:
 * - `open`: at most one per OPEN_EVERY_MS (30 minutes) per user. A call
 *   while her newest `open` is younger than that is dropped, so the first
 *   page view of a visit is what counts. The beacon in `(app)/template.tsx`
 *   sends this on every page view; the throttle lives here, on the server.
 * - `start`: a study session or an assignment opened. `ms` is the time since
 *   that visit's `open`. When the caller passes none, it is computed here from
 *   her newest `open` at or before now, as long as that open is at most
 *   VISIT_MAX_MS (3 hours) old; an older open is another visit, so `ms` is
 *   stored as null. Every start is stored; the summary takes the first start
 *   after each open (`./summary`).
 * - `hand_in`: a hand-in went through. No `ms`.
 *
 * Demo users (`users.settings.demo` is true, M1-37) are never logged, and
 * neither are ids with no user row. The check is the same JSON test as
 * `isDemoSql` in `@/server/users/cleanup`, written out here so the app shell
 * (which loads this file through the template) does not load the demo seed.
 *
 * `logEvent` never throws: usage logging must not break the app. Any failure
 * (bad id, database down) returns false. It returns true when a row was
 * written.
 *
 * The 30-minute check and the insert are two statements, so two page views
 * in the same few milliseconds could both write an `open`. The beacon sends
 * one per page view, and the summary counts days opened and the first start
 * after an open, so a rare double row changes nothing it reports.
 *
 * Call sites:
 * - `open` and the `start` of an assignment or study page: `recordPageView`,
 *   called by the server action in `src/app/(app)/template.tsx`.
 * - Follow-up (files this ticket may not touch): `start` from `beginSession`
 *   in `src/server/study/actions.ts` once a study page calls it, and
 *   `hand_in` from `confirmHandinAction` in
 *   `src/app/(app)/assignments/[id]/actions.ts` when `confirmHandin` reports
 *   a hand-in that went through.
 */
import { and, desc, eq, gt, lte } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { usageEvents } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";

export const USAGE_KINDS = ["open", "start", "hand_in"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/** At most one `open` per user in this window. */
export const OPEN_EVERY_MS = 30 * 60_000;
/** A `start` further than this from her newest `open` belongs to no visit (`ms` null). */
export const VISIT_MAX_MS = 3 * 60 * 60_000;

export type LogOptions = { db?: Db; now?: Date };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isKind(kind: unknown): kind is UsageKind {
  return (USAGE_KINDS as readonly unknown[]).includes(kind);
}

/** A whole, non-negative number of milliseconds, or null. */
function cleanMs(ms: unknown): number | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  return Math.min(Math.round(ms), 2_147_483_647); // the column is a 32-bit integer
}

/** Write one usage event. Never throws; true when a row was written. */
export async function logEvent(
  userId: string,
  kind: UsageKind,
  ms?: number | null,
  options: LogOptions = {},
): Promise<boolean> {
  try {
    if (typeof userId !== "string" || !UUID.test(userId) || !isKind(kind)) return false;
    const database = options.db ?? defaultDb;
    const now = options.now ?? new Date();

    const [user] = await database
      .select({ settings: users.settings })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user || user.settings?.demo === true) return false;

    let value = kind === "hand_in" ? null : cleanMs(ms);
    if (kind !== "hand_in") {
      const [lastOpen] = await database
        .select({ at: usageEvents.at })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.userId, userId),
            eq(usageEvents.kind, "open"),
            lte(usageEvents.at, now),
            gt(usageEvents.at, new Date(now.getTime() - (kind === "open" ? OPEN_EVERY_MS : VISIT_MAX_MS))),
          ),
        )
        .orderBy(desc(usageEvents.at))
        .limit(1);
      if (kind === "open") {
        if (lastOpen) return false;
        value = null;
      } else if (value === null && lastOpen) {
        value = now.getTime() - lastOpen.at.getTime();
      }
    }

    await database.insert(usageEvents).values({ userId, kind, at: now, ms: value });
    return true;
  } catch {
    return false;
  }
}

/** Pages where opening one counts as starting: an assignment, or a study page. */
export function isStartPath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  return /^\/assignments\/[^/?#]+\/?$/.test(path) || /^\/study(\/|$)/.test(path);
}

/**
 * One page view inside the app (the beacon in `(app)/template.tsx`): an
 * `open` (dropped by the 30-minute throttle when she is mid-visit), then a
 * `start` when the page is an assignment or a study page. The `open` goes
 * first, so landing straight on an assignment from a link is a start 0 ms
 * after the open. Never throws.
 */
export async function recordPageView(userId: string, path: unknown, options: LogOptions = {}): Promise<void> {
  await logEvent(userId, "open", null, options);
  if (isStartPath(path)) await logEvent(userId, "start", null, options);
}

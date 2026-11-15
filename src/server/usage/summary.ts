/*
 * Weekly view of the usage log (M8-28), for one user:
 *
 *   const weeks = await usageSummary(userId);   // M8-27 reads this in a one-off query
 *   // [{ week: "2026-W46", weekStart: "2026-11-09", daysOpened: 3, opens: 4, starts: 2, medianStartMs: 6100 }]
 *
 * `summarize(rows)` is the pure part and takes the rows in any order.
 *
 * - Weeks are ISO weeks (Monday to Sunday) of the Helsinki calendar. Only
 *   weeks with at least one `open` are listed, oldest first.
 * - `daysOpened`: distinct Helsinki days with an `open` in that week. The
 *   signal is "3 times a week unprompted".
 * - `medianStartMs`: for each `open`, the first `start` after it and before
 *   the next `open`; its stored `ms`, or the time between the two when `ms`
 *   is null. The open's week owns the value. Median of those; with an even
 *   count, the mean of the middle two, rounded. Null when the week has no
 *   start. The signal is "opening to studying takes under 10 seconds".
 * - `starts` is how many opens had a start, so a median over one visit can be
 *   read as such.
 */
import { asc, eq } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { usageEvents } from "@/server/db/schema/system";

export type UsageRow = { kind: string; at: Date; ms: number | null };

export type WeekSummary = {
  /** ISO week, `2026-W46`. */
  week: string;
  /** Monday of that week, Helsinki calendar, `2026-11-09`. */
  weekStart: string;
  daysOpened: number;
  opens: number;
  /** Opens followed by a start before the next open. */
  starts: number;
  medianStartMs: number | null;
};

const DAY_MS = 24 * 60 * 60_000;

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Helsinki",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Helsinki calendar day, `YYYY-MM-DD`. */
export function helsinkiDay(at: Date): string {
  const p: Record<string, string> = {};
  for (const part of dayFormat.formatToParts(at)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/** ISO week and its Monday for a `YYYY-MM-DD` calendar day. */
export function isoWeek(day: string): { week: string; weekStart: string } {
  const [y, m, d] = day.split("-").map(Number);
  const date = Date.UTC(y, m - 1, d);
  const weekday = (new Date(date).getUTCDay() + 6) % 7; // Monday 0
  const monday = date - weekday * DAY_MS;
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return {
    week: `${year}-W${String(week).padStart(2, "0")}`,
    weekStart: new Date(monday).toISOString().slice(0, 10),
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Per-week summary of one user's rows (any order). */
export function summarize(rows: readonly UsageRow[]): WeekSummary[] {
  const events = rows
    .filter((r) => r.kind === "open" || r.kind === "start")
    .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.kind === "open" ? -1 : 1));

  type Acc = { weekStart: string; days: Set<string>; opens: number; startMs: number[] };
  const weeks = new Map<string, Acc>();
  let open: { at: Date; acc: Acc; started: boolean } | null = null;

  for (const e of events) {
    if (e.kind === "open") {
      const day = helsinkiDay(e.at);
      const { week, weekStart } = isoWeek(day);
      let acc = weeks.get(week);
      if (!acc) {
        acc = { weekStart, days: new Set(), opens: 0, startMs: [] };
        weeks.set(week, acc);
      }
      acc.days.add(day);
      acc.opens += 1;
      open = { at: e.at, acc, started: false };
    } else if (open && !open.started) {
      open.started = true;
      open.acc.startMs.push(e.ms ?? Math.max(0, e.at.getTime() - open.at.getTime()));
    }
  }

  return [...weeks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([week, acc]) => ({
      week,
      weekStart: acc.weekStart,
      daysOpened: acc.days.size,
      opens: acc.opens,
      starts: acc.startMs.length,
      medianStartMs: median(acc.startMs),
    }));
}

/** The weekly summary of one user's usage log. */
export async function usageSummary(userId: string, database: Db = defaultDb): Promise<WeekSummary[]> {
  const rows = await database
    .select({ kind: usageEvents.kind, at: usageEvents.at, ms: usageEvents.ms })
    .from(usageEvents)
    .where(eq(usageEvents.userId, userId))
    .orderBy(asc(usageEvents.at));
  return summarize(rows);
}

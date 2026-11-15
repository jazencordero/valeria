import { createHash, timingSafeEqual } from "node:crypto";
import { drain } from "@/server/jobs/queue";
import { SYNC_KIND, runBackgroundSync } from "@/server/sync/schedule";

// Drains the `sync` job kind (M7-05): one job per user, added by
// `scheduleSyncs` (src/server/sync/schedule.ts), which the hourly tick calls
// first. Each job runs `runBackgroundSync` for its user: `syncNow(userId,
// { force: true })` again while it says `more`, within a time budget.
//
// Called by the hourly tick (../tick/route.ts) as POST with
// `Authorization: Bearer <CRON_SECRET>`. Without CRON_SECRET in the
// environment every request gets 401: the route is never open. The secret is
// not logged or echoed anywhere, and nothing here logs at all.
//
// Answer: { ok, done, retried, failed, synced, unfinished, expired, skipped }.
// `done`, `retried` and `failed` are what `drain` says; the other four count
// how the jobs that ran ended (see `runBackgroundSync`). A rejected key, a
// disconnect and Moodle being down all end the job as `done`: trying again
// soon cannot help, and the next tick schedules her again while she is stale
// (never with a rejected key, at most 4 a day). Anything thrown (the database
// is down, a bug) is retried by the queue later.
//
// Time: the host gives a request 300 s at most (see src/app/api/sync/route.ts
// for the sources). No new job starts after BUDGET_MS; the job running then
// starts no new `syncNow` call after its own 60 s, and one call stops starting
// Moodle calls after 8 s, each cut off after 15 s. Set as
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md says.
export const maxDuration = 300;
// No `dynamic` export: this app uses `cacheComponents`, which forbids it, and a
// handler that reads the request's headers is never prerendered anyway.

const BUDGET_MS = 150_000;
const MAX_JOBS = 25;

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

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const outcomes = { synced: 0, unfinished: 0, expired: 0, skipped: 0 };
  const result = await drain(
    SYNC_KIND,
    async (_payload, job) => {
      // A job with no user has nothing to sync.
      if (!job.userId) {
        outcomes.skipped += 1;
        return;
      }
      const { outcome } = await runBackgroundSync(job.userId);
      outcomes[outcome] += 1;
    },
    { max: MAX_JOBS, budgetMs: BUDGET_MS },
  );

  return Response.json({ ok: result.failed === 0, ...result, ...outcomes });
}

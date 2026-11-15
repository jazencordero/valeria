import { createHash, timingSafeEqual } from "node:crypto";
import { drain } from "@/server/jobs/queue";
import { cleanup } from "@/server/users/cleanup";
import { CLEANUP_KIND } from "@/server/users/schedule";

// Drains the `cleanup` job kind (M2-25): at most one job a day, added by
// `scheduleCleanup` (GET /demo calls it on every visit). Each job runs
// `cleanup`, which deletes users with no Moodle connection idle for over 30
// days and demo users idle for over 7 days. A connected user is never deleted.
//
// Called by the hourly tick (../tick/route.ts) as POST with
// `Authorization: Bearer <CRON_SECRET>`. Without CRON_SECRET in the
// environment every request gets 401: the route is never open. The secret is
// not logged or echoed anywhere, and nothing here logs at all.
//
// Answer: { ok, done, retried, failed, deleted: { anonymous, demo } }. `done`,
// `retried` and `failed` are what `drain` says. An error (the database is
// down) is thrown, so the queue tries that job again later.
//
// Time: one job is one DELETE statement. The budget mirrors the other cron
// routes; set as
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md says.
export const maxDuration = 300;
// No `dynamic` export: this app uses `cacheComponents`, which forbids it, and a
// handler that reads the request's headers is never prerendered anyway.

const BUDGET_MS = 120_000;
// Normally there is one job; a few allow for days the tick missed.
const MAX_JOBS = 5;

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

  const deleted = { anonymous: 0, demo: 0 };
  const result = await drain(
    CLEANUP_KIND,
    async () => {
      const one = await cleanup();
      deleted.anonymous += one.anonymous;
      deleted.demo += one.demo;
    },
    { max: MAX_JOBS, budgetMs: BUDGET_MS },
  );

  return Response.json({ ok: result.failed === 0, ...result, deleted });
}

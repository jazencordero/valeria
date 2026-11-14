import { createHash, timingSafeEqual } from "node:crypto";
import { ESTIMATE_KIND, estimateJob, type EstimateTally } from "@/server/ai/jobs/estimate";
import { drain } from "@/server/jobs/queue";

// M2-12: drains the `estimate` jobs (how long an assignment takes, src/server/ai/jobs/estimate.ts),
// one per assignment with no estimate, added by a finished `syncNow`. Each job asks the small model
// for one number and writes `assignments.estimate_min`; assignments in a course not marked as
// allowing AI are skipped without asking anything.
//
// Called by the hourly tick (../tick/route.ts) as POST with `Authorization: Bearer <CRON_SECRET>`.
// Without CRON_SECRET in the environment every request gets 401: the route is never open. The
// secret is not logged or echoed, and nothing here logs a brief, a prompt or a reply.
//
// Answer: { ok, kind, done, retried, failed, estimates: { estimated, skipped, noNumber } }.
// `done`/`retried`/`failed` count jobs (DrainResult in src/server/jobs/queue.ts). When every free
// AI provider is busy the job throws `AiBusy` and the queue tries it again later (1, 5, 30, 30 min).
//
// Time: no new job starts after BUDGET_MS. One job is one small-model call, so the job running then
// has the rest of maxDuration to finish. Set as
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md says.
export const maxDuration = 300;
// No `dynamic` export: this app uses `cacheComponents`, which forbids it, and a
// handler that reads the request's headers is never prerendered anyway.

const BUDGET_MS = 120_000;
const MAX_JOBS = 50;

/** True when the request carries the cron secret. Compared in constant time. */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  // Hashing first gives both sides the same length, which timingSafeEqual needs.
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const estimates: EstimateTally = { estimated: 0, skipped: 0, noNumber: 0 };
  const result = await drain(ESTIMATE_KIND, estimateJob({ tally: estimates }), {
    max: MAX_JOBS,
    budgetMs: BUDGET_MS,
  });
  return Response.json({ ok: result.failed === 0, kind: ESTIMATE_KIND, ...result, estimates });
}

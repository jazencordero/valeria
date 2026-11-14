import { createHash, timingSafeEqual } from "node:crypto";
import {
  EXTRACT_KIND,
  extractJob,
  type ExtractTally,
} from "@/server/files/extract";
import { drain } from "@/server/jobs/queue";

// M2-09: drains the `extract` jobs (text out of her course files, src/server/files/extract.ts).
// The hourly tick (src/app/api/cron/tick) calls it with `Authorization: Bearer <CRON_SECRET>`
// whenever `extract` jobs are due.
//
// Answer: { ok, kind, done, retried, failed, files: { extracted, failed, missing } }.
// `done`/`retried`/`failed` count jobs (see DrainResult in src/server/jobs/queue.ts); `files`
// counts what the finished jobs did to files (a file that failed for good is a job done).
//
// Without CRON_SECRET in the environment every request gets 401. The secret is not logged
// or echoed, and nothing here logs file text.
//
// No new job starts after BUDGET_MS (40 s). The job running at that moment may still take up
// to the Moodle answer timeout (15 s) plus the download timeout (30 s) plus reading the PDF,
// so the route gets 120 s. Set as
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md says.
export const maxDuration = 120;
// No `dynamic` export: this app uses `cacheComponents`, which forbids it, and a
// handler that reads the request's headers is never prerendered anyway.

const BUDGET_MS = 40_000;
/** Most jobs per call; the budget usually ends a drain first. */
const MAX_JOBS = 100;

/** True when the request carries the cron secret. Compared in constant time. */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

async function run(request: Request): Promise<Response> {
  if (!authorized(request))
    return Response.json({ error: "unauthorized" }, { status: 401 });

  const files: ExtractTally = { extracted: 0, failed: 0, missing: 0 };
  const result = await drain(EXTRACT_KIND, extractJob({ tally: files }), {
    max: MAX_JOBS,
    budgetMs: BUDGET_MS,
  });
  return Response.json({ ok: true, kind: EXTRACT_KIND, ...result, files });
}

export const GET = run;
export const POST = run;

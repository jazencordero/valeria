import { createHash, timingSafeEqual } from "node:crypto";
import { drain } from "@/server/jobs/queue";
import { KeyRejected, NotAllowed } from "@/server/moodle/client";
import { NotConnected } from "@/server/sync/courses";
import { SYNC_FILES_KIND, syncFiles } from "@/server/sync/files";

// Drains the `sync-files` job kind (M2-08): one job per user, added by a
// finished `syncNow`. Each job runs `syncFiles` for its user, which lists the
// files on her course pages and queues `extract` jobs for the readable ones.
//
// Called by the hourly tick (../tick/route.ts) as POST with
// `Authorization: Bearer <CRON_SECRET>`. Without CRON_SECRET in the
// environment every request gets 401: the route is never open. The secret is
// not logged or echoed anywhere, and nothing here logs at all.
//
// Answer: { ok, done, retried, failed, skipped, files: { added, updated, queued } }.
// `done`, `retried` and `failed` are what `drain` says. `skipped` counts jobs
// that ended without a sync because trying again cannot help: she has
// disconnected, Moodle rejects her key, or her key may not read course pages.
// Those count as `done` too. Any other error (Moodle down, a broken answer)
// is thrown, so the queue tries that job again later (1, 5, 30, 30 minutes).
//
// Time: the host gives a request 300 s at most (see src/app/api/sync/route.ts
// for the sources). No new job starts after BUDGET_MS, which leaves the job
// that is running then 3 minutes to finish: one job is one Moodle call per
// course, each cut off after 15 s. Set as
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md says.
export const maxDuration = 300;
// No `dynamic` export: this app uses `cacheComponents`, which forbids it, and a
// handler that reads the request's headers is never prerendered anyway.

const BUDGET_MS = 120_000;
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

  const files = { added: 0, updated: 0, queued: 0 };
  let skipped = 0;
  const result = await drain(
    SYNC_FILES_KIND,
    async (_payload, job) => {
      // A job with no user has nothing to sync.
      if (!job.userId) {
        skipped += 1;
        return;
      }
      try {
        const one = await syncFiles(job.userId);
        files.added += one.added;
        files.updated += one.updated;
        files.queued += one.queued;
      } catch (err) {
        if (err instanceof NotConnected || err instanceof KeyRejected || err instanceof NotAllowed) {
          skipped += 1;
          return;
        }
        throw err;
      }
    },
    { max: MAX_JOBS, budgetMs: BUDGET_MS },
  );

  return Response.json({ ok: result.failed === 0, ...result, skipped, files });
}

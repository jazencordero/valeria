import { createHash, timingSafeEqual } from "node:crypto";
import { KIND_PATTERN, dueKinds, enqueue } from "@/server/jobs/queue";
import { scheduleSyncs } from "@/server/sync/schedule";

// The hourly tick (M2-06). GitHub Actions calls it once an hour
// (.github/workflows/tick.yml) with `Authorization: Bearer <CRON_SECRET>`.
//
// It asks the jobs table which kinds have due work and, for each, calls this
// same app's `/api/cron/<kind>` with the same header. Each job kind brings its
// own route under `src/app/api/cron/<kind>/route.ts`, which checks the secret
// again and drains its queue; nothing here lists the kinds.
//
// Before that it queues background syncs (M7-05, `scheduleSyncs`) and the
// next hour's reminder pass (M7-07, `queueRemind`); see below.
//
// Answer: { ok, kinds: [{ kind, status, ok }], skipped: [kind] }, plus
// `scheduleFailed: true` when queueing the background syncs threw, and
// `remindFailed: true` when queueing the reminder pass threw. `status` is
// what the kind's route answered (0 = it could not be reached). The tick itself
// answers 200 even when a kind's route fails: the jobs stay queued and the next
// tick tries again. `skipped` holds kinds whose name is not a-z and dashes;
// they are never put into a URL.
//
// Without CRON_SECRET in the environment every request gets 401: the route is
// never open. The secret is not logged or echoed anywhere.
//
// The kinds are called one after another and each may take a while, so the
// route gets the host's full 300 s (see src/app/api/sync/route.ts for the
// sources). Set as node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md says.
export const maxDuration = 300;
// No `dynamic` export: this app uses `cacheComponents`, which forbids it, and a
// handler that reads the request's headers is never prerendered anyway.

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

/** The job kind src/app/api/cron/remind/route.ts drains. */
const REMIND_KIND = "remind";
const HOUR_MS = 60 * 60_000;

/**
 * Queues one `remind` job for the start of the next UTC hour, deduped by that
 * hour (`remind:2026-11-15T17`), so ticks in the same hour add one job. The
 * job is due from the next hour's tick, which runs it: one reminder pass an
 * hour, each at the first tick of its hour. (Due on a later tick, not this
 * one, so this tick's answer lists the same kinds as before.) The pass itself
 * never sends a reminder twice (`reminder_log`), so an extra job is harmless.
 */
async function queueRemind(now: Date): Promise<void> {
  const nextHour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
  await enqueue(REMIND_KIND, {}, { runAfter: nextHour, dedupeKey: `remind:${nextHour.toISOString().slice(0, 13)}` });
}

async function tick(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const origin = new URL(request.url).origin;
  const authorization = request.headers.get("authorization")!;
  const kinds: { kind: string; status: number; ok: boolean }[] = [];
  const skipped: string[] = [];

  // First, queue background syncs for users whose data is stale (M7-05,
  // src/server/sync/schedule.ts). Their jobs run after a jitter, so mostly on
  // a later tick. A failure here must not stop the rest of the tick: the jobs
  // already queued still run, and the next tick schedules again. The answer
  // only says so (`scheduleFailed: true`); the error is not logged, since it
  // could carry database details.
  let scheduleFailed = false;
  try {
    await scheduleSyncs();
  } catch {
    scheduleFailed = true;
  }

  // Then the reminder pass for the next hour (M7-07). Same rule: a failure
  // only shows as `remindFailed: true`; the next tick queues again.
  let remindFailed = false;
  try {
    await queueRemind(new Date());
  } catch {
    remindFailed = true;
  }

  for (const kind of await dueKinds()) {
    if (!KIND_PATTERN.test(kind)) {
      skipped.push(kind);
      continue;
    }
    try {
      // `redirect: "manual"`: the secret goes to this app's own route and nowhere a redirect points.
      const res = await fetch(`${origin}/api/cron/${kind}`, {
        method: "POST",
        headers: { authorization },
        redirect: "manual",
        cache: "no-store",
      });
      await res.body?.cancel();
      kinds.push({ kind, status: res.status, ok: res.ok });
    } catch {
      kinds.push({ kind, status: 0, ok: false });
    }
  }

  return Response.json({
    ok: kinds.every((k) => k.ok),
    kinds,
    skipped,
    ...(scheduleFailed ? { scheduleFailed } : {}),
    ...(remindFailed ? { remindFailed } : {}),
  });
}

export const GET = tick;
export const POST = tick;

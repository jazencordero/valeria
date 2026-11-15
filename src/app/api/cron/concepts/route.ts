import { createHash, timingSafeEqual } from "node:crypto";
import { CONCEPTS_KIND, conceptsJob, type ConceptsTally } from "@/server/ai/jobs/concepts";
import { drain } from "@/server/jobs/queue";

// M3-14: drains the `concepts` jobs (sort a course's lectures into concepts,
// src/server/ai/jobs/concepts.ts), one per new exam whose course has extracted lecture files,
// added by `addExam` and by the Moodle sync (`queueConcepts` in src/server/study/exams.ts).
// Each job asks the small model once (plus at most one repair) and writes the exam's `concepts`
// rows. Courses whose study material may not go to an AI model, or where her switch is off, are
// skipped without asking anything.
//
// Called by the hourly tick (../tick/route.ts) as POST with `Authorization: Bearer <CRON_SECRET>`.
// Without CRON_SECRET in the environment every request gets 401: the route is never open. The
// secret is not logged or echoed, and nothing here logs file text, a prompt or a reply.
//
// Answer: { ok, kind, done, retried, failed, concepts: { made, skipped, kept, badOutput } }.
// `done`/`retried`/`failed` count jobs (DrainResult in src/server/jobs/queue.ts). When every free
// AI provider is busy the job throws `AiBusy` and the queue tries it again later (1, 5, 30, 30 min).
//
// Time: no new job starts after BUDGET_MS, so the job running then has the rest of maxDuration
// to finish. Set as
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md says.
export const maxDuration = 300;
// No `dynamic` export: this app uses `cacheComponents`, which forbids it, and a
// handler that reads the request's headers is never prerendered anyway.

const BUDGET_MS = 120_000;
const MAX_JOBS = 20;

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

  const tally: ConceptsTally = { made: 0, skipped: 0, kept: 0, badOutput: 0 };
  const result = await drain(CONCEPTS_KIND, conceptsJob({ tally }), { max: MAX_JOBS, budgetMs: BUDGET_MS });
  return Response.json({ ok: result.failed === 0, kind: CONCEPTS_KIND, ...result, concepts: tally });
}

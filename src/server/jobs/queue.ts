/*
 * Background jobs (M2-06): one table, `enqueue` to add work, `drain` to do it.
 *
 *   await enqueue("lecture-pages", { courseId }, { userId, dedupeKey: `course:${courseId}` });
 *   await drain("lecture-pages", async (payload) => { ... }, { max: 5, budgetMs: 20_000 });
 *
 * A job kind is lower-case letters and dashes (`KIND_PATTERN`), because the
 * hourly tick calls `/api/cron/<kind>` for every kind that has due work.
 *
 * How one job moves:
 *
 *   queued --claim--> running --handler ok-----> done
 *                        |-----handler throws--> queued again, later (backoff)
 *                        |                       or failed, on the 5th try
 *                        '-----lease runs out--> claimed again (the tick crashed)
 *
 * Tries and backoff. `attempts` counts tries *started*: it goes up when a job
 * is claimed, so a try that dies with its tick still counts. A job gets
 * MAX_TRIES (5) tries. After a failed try it waits 1, 5, 30 and then 30 minutes
 * (the fourth wait stays at 30: the plan names three steps and nothing here
 * needs longer). The fifth failure ends it: `failed`, with `last_error`.
 *
 * A job stuck in `running`. Claiming also moves `run_after` forward by the
 * lease (15 minutes, longer than any request the host lets run). While a job
 * is `running`, `run_after` therefore means "if nobody has finished me by
 * then, take me again". A tick that crashed mid-job leaves exactly such a row,
 * and a later drain picks it up as another try. If it had already used all
 * five tries it is marked `failed` instead. A handler must be safe to run
 * twice for the same job (at-least-once), because a slow first run can still
 * finish after its lease ran out; its late "done" is then ignored (see `settle`).
 *
 * dedupeKey. The jobs table has no column for it, so the key is kept inside
 * the stored payload under `_dedupeKey` and taken out again before the handler
 * sees the payload. Payloads are therefore plain objects, and `_dedupeKey` is
 * a reserved name.
 */
import { and, asc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { jobs } from "@/server/db/schema/system";

export const KIND_PATTERN = /^[a-z-]+$/;
export const MAX_TRIES = 5;
/** Minutes to wait after the 1st, 2nd, 3rd and 4th failed try. */
export const BACKOFF_MINUTES = [1, 5, 30, 30] as const;
export const LEASE_MS = 15 * 60_000;

const MINUTE = 60_000;
const DEDUPE_FIELD = "_dedupeKey";
const LAST_ERROR_MAX = 2000;

export type JobPayload = Record<string, unknown>;
export type Clock = () => Date;

export type EnqueueOptions = {
  userId?: string | null;
  /** Earliest time the job may run. Default: now. */
  runAfter?: Date;
  /** While a job of this kind with this key is queued or running, no second one is added. */
  dedupeKey?: string;
  db?: Db;
  now?: Clock;
};

export type EnqueueResult = {
  id: string;
  /** False when a queued or running job with the same dedupeKey already existed; `id` is that job's. */
  created: boolean;
};

export type JobInfo = {
  id: string;
  kind: string;
  userId: string | null;
  /** Which try this is, starting at 1. */
  attempt: number;
};

export type JobHandler<P extends JobPayload = JobPayload> = (payload: P, job: JobInfo) => Promise<void> | void;

export type DrainOptions = {
  /** Most jobs to run in this call. Default 10. */
  max?: number;
  /** Start no new job once this much time has passed. Default 20 s. A job already running is not cut off. */
  budgetMs?: number;
  leaseMs?: number;
  db?: Db;
  now?: Clock;
};

export type DrainResult = {
  /** Jobs whose handler finished. */
  done: number;
  /** Jobs whose handler threw and that will be tried again later. */
  retried: number;
  /** Jobs that ended `failed` in this call (fifth failure, or a crashed fifth try). */
  failed: number;
};

function assertKind(kind: string): void {
  if (!KIND_PATTERN.test(kind)) throw new Error(`job kind must match ${KIND_PATTERN}: got "${kind}"`);
}

/** A job that could still run: waiting, or being worked on. */
const live = or(eq(jobs.status, "queued"), eq(jobs.status, "running"));

export async function enqueue(
  kind: string,
  payload: JobPayload = {},
  { userId = null, runAfter, dedupeKey, db = defaultDb, now = () => new Date() }: EnqueueOptions = {},
): Promise<EnqueueResult> {
  assertKind(kind);
  if (DEDUPE_FIELD in payload) throw new Error(`"${DEDUPE_FIELD}" is reserved in a job payload`);
  const values = { kind, userId, runAfter: runAfter ?? now() };

  if (dedupeKey === undefined) {
    const [row] = await db.insert(jobs).values({ ...values, payload }).returning({ id: jobs.id });
    return { id: row.id, created: true };
  }

  // "Look, then insert" is only safe if nobody else can look in between. The
  // advisory lock is held until the transaction ends and is keyed on kind and
  // dedupeKey, so two enqueues of the same key go one after the other while
  // everything else is untouched. (A kind has no ":" in it, so "kind:key" is
  // unambiguous.)
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${kind}:${dedupeKey}`}, 0))`);
    const [existing] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, kind), live, sql`${jobs.payload}->>'${sql.raw(DEDUPE_FIELD)}' = ${dedupeKey}`))
      .limit(1);
    if (existing) return { id: existing.id, created: false };
    const [row] = await tx
      .insert(jobs)
      .values({ ...values, payload: { ...payload, [DEDUPE_FIELD]: dedupeKey } })
      .returning({ id: jobs.id });
    return { id: row.id, created: true };
  });
}

/**
 * Takes one due job of this kind for the caller, or returns nothing.
 *
 * Why two drains can never both get the same job on real Postgres: it is one
 * statement, shaped
 *
 *   UPDATE jobs SET status = 'running', attempts = attempts + 1, run_after = <now + lease>
 *   WHERE id IN (SELECT id FROM jobs WHERE <due> ORDER BY ... LIMIT 1 FOR UPDATE SKIP LOCKED)
 *   RETURNING ...
 *
 * - `FOR UPDATE` locks the row the inner SELECT picks until the statement's
 *   transaction ends. `SKIP LOCKED` makes a second drain running at the same
 *   moment pass over that locked row and pick the next one instead of waiting.
 * - If the second drain comes a moment later, when the first has already
 *   committed, the row is unlocked but changed. Under READ COMMITTED (the
 *   default) Postgres then re-checks the WHERE against the new version of the
 *   row before locking it: it is now `running` with `run_after` in the future,
 *   so it is no longer due and is left alone.
 *
 * PGlite (local and tests) has a single connection, so statements simply run
 * one after another there; the same statement is trivially safe.
 */
async function claim(db: Db, kind: string, at: Date, leaseMs: number) {
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, kind), live, lte(jobs.runAfter, at)))
    .orderBy(asc(jobs.runAfter), asc(jobs.createdAt))
    .limit(1)
    .for("update", { skipLocked: true });
  const [job] = await db
    .update(jobs)
    .set({ status: "running", attempts: sql`${jobs.attempts} + 1`, runAfter: new Date(at.getTime() + leaseMs) })
    .where(inArray(jobs.id, due))
    .returning();
  return job;
}

/** Jobs left `running` by a tick that died on their last allowed try: they end here. */
async function failWornOut(db: Db, kind: string, at: Date): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ status: "failed", lastError: `stopped without finishing on try ${MAX_TRIES} (the run was cut off)` })
    .where(
      and(eq(jobs.kind, kind), eq(jobs.status, "running"), lte(jobs.runAfter, at), gte(jobs.attempts, MAX_TRIES)),
    )
    .returning({ id: jobs.id });
  return rows.length;
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, LAST_ERROR_MAX);
}

export async function drain<P extends JobPayload = JobPayload>(
  kind: string,
  handler: JobHandler<P>,
  { max = 10, budgetMs = 20_000, leaseMs = LEASE_MS, db = defaultDb, now = () => new Date() }: DrainOptions = {},
): Promise<DrainResult> {
  assertKind(kind);
  const started = now().getTime();
  const result: DrainResult = { done: 0, retried: 0, failed: 0 };
  result.failed += await failWornOut(db, kind, now());

  // One job is claimed at a time, so stopping early (max or budget) never
  // leaves a claimed job that nobody runs.
  for (let ran = 0; ran < max && now().getTime() - started < budgetMs; ran++) {
    const job = await claim(db, kind, now(), leaseMs);
    if (!job) break;
    const tries = job.attempts;

    // Only the try that claimed the job may settle it. If the lease ran out
    // and someone else took the job, `attempts` has moved on and this does nothing.
    const settle = (set: Partial<typeof jobs.$inferInsert>) =>
      db
        .update(jobs)
        .set(set)
        .where(and(eq(jobs.id, job.id), eq(jobs.status, "running"), eq(jobs.attempts, tries)));

    const { [DEDUPE_FIELD]: _dedupeKey, ...payload } = job.payload as JobPayload;
    void _dedupeKey;
    try {
      await handler(payload as P, { id: job.id, kind, userId: job.userId, attempt: tries });
    } catch (err) {
      const lastError = errorText(err);
      if (tries >= MAX_TRIES) {
        await settle({ status: "failed", lastError });
        result.failed++;
      } else {
        const wait = BACKOFF_MINUTES[Math.min(tries, BACKOFF_MINUTES.length) - 1] * MINUTE;
        await settle({ status: "queued", lastError, runAfter: new Date(now().getTime() + wait) });
        result.retried++;
      }
      continue;
    }
    await settle({ status: "done" });
    result.done++;
  }
  return result;
}

/** The kinds that have work to do right now, in a-z order. What the hourly tick asks. */
export async function dueKinds({ db = defaultDb, now = () => new Date() }: { db?: Db; now?: Clock } = {}): Promise<
  string[]
> {
  const rows = await db
    .selectDistinct({ kind: jobs.kind })
    .from(jobs)
    .where(and(live, lte(jobs.runAfter, now())))
    .orderBy(asc(jobs.kind));
  return rows.map((r) => r.kind);
}

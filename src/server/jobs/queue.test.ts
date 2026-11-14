// @vitest-environment node
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobs } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { BACKOFF_MINUTES, LEASE_MS, MAX_TRIES, drain, dueKinds, enqueue } from "./queue";

// The tick route reads the shared `db`; here that is the test's own database.
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/client")>()),
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        const real = holder.db as object;
        const value: unknown = Reflect.get(real, prop, real);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
      },
    },
  ),
}));

// The machine can be busy; a fresh database per test takes a while.
const SLOW = 120_000;
const MINUTE = 60_000;
// A made-up value for tests only.
const TEST_SECRET = "test-only-cron-secret-not-real";

let t: TestDb;
/** The clock the queue is given. Tests move it by hand. */
let clock: Date;
const now = () => new Date(clock);
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const opts = () => ({ db: t.db, now });

beforeEach(async () => {
  t = await createTestDb();
  holder.db = t.db;
  clock = new Date("2026-11-14T10:00:00Z");
}, SLOW);
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await t.close();
});

const allJobs = () => t.db.select().from(jobs).orderBy(asc(jobs.createdAt), asc(jobs.id));
async function jobById(id: string) {
  const [row] = await t.db.select().from(jobs).where(eq(jobs.id, id));
  return row;
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("enqueue", () => {
  it("adds a queued job that is due now, with its payload and user", { timeout: SLOW }, async () => {
    const [user] = await t.db.insert(users).values({}).returning();
    const { id, created } = await enqueue("send-mail", { to: 7 }, { ...opts(), userId: user.id });
    expect(created).toBe(true);
    expect(await jobById(id)).toMatchObject({
      kind: "send-mail",
      userId: user.id,
      payload: { to: 7 },
      status: "queued",
      attempts: 0,
      lastError: null,
      runAfter: now(),
    });
  });

  it("refuses a kind that could not be a cron route name", { timeout: SLOW }, async () => {
    for (const bad of ["", "Sync", "a/b", "../tick", "a_b", "a1", "a b"]) {
      await expect(enqueue(bad, {}, opts())).rejects.toThrow(/job kind/);
    }
    expect(await allJobs()).toEqual([]);
  });

  it("does not add a second job for a dedupeKey that is queued or running", { timeout: SLOW }, async () => {
    const first = await enqueue("pages", { n: 1 }, { ...opts(), dedupeKey: "course:1" });
    const again = await enqueue("pages", { n: 2 }, { ...opts(), dedupeKey: "course:1" });
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });

    // Another key, another kind, and no key at all are separate jobs.
    expect((await enqueue("pages", {}, { ...opts(), dedupeKey: "course:2" })).created).toBe(true);
    expect((await enqueue("cards", {}, { ...opts(), dedupeKey: "course:1" })).created).toBe(true);
    expect((await enqueue("pages", {}, opts())).created).toBe(true);
    expect(await allJobs()).toHaveLength(4);

    // Still held back while the job is running...
    let whileRunning: { created: boolean } | undefined;
    const seen: unknown[] = [];
    await drain(
      "pages",
      async (payload) => {
        seen.push(payload);
        if (payload.n === 1) whileRunning = await enqueue("pages", {}, { ...opts(), dedupeKey: "course:1" });
      },
      opts(),
    );
    expect(whileRunning?.created).toBe(false);
    // ...and the handler never sees the key.
    expect(seen).toContainEqual({ n: 1 });
    expect(seen.every((p) => !("_dedupeKey" in (p as object)))).toBe(true);

    // Once it is done, the same key may be queued again.
    expect((await enqueue("pages", { n: 3 }, { ...opts(), dedupeKey: "course:1" })).created).toBe(true);
  });

  it("adds one job when the same dedupeKey is enqueued many times at once", { timeout: SLOW }, async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => enqueue("pages", {}, { ...opts(), dedupeKey: "same" })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await allJobs()).toHaveLength(1);
  });
});

describe("drain", () => {
  it("two drains at the same time run each job exactly once", { timeout: SLOW }, async () => {
    const ids: string[] = [];
    for (let i = 0; i < 24; i++) ids.push((await enqueue("work", { i }, opts())).id);

    const runs = new Map<string, number>();
    const handler = async (_payload: unknown, job: { id: string }) => {
      runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
      await pause(Math.random() * 4); // let the two drains interleave
    };
    const [a, b] = await Promise.all([
      drain("work", handler, { ...opts(), max: 100 }),
      drain("work", handler, { ...opts(), max: 100 }),
    ]);

    expect(a.done + b.done).toBe(24);
    expect([...runs.keys()].sort()).toEqual([...ids].sort());
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
    const rows = await allJobs();
    expect(rows.every((r) => r.status === "done" && r.attempts === 1)).toBe(true);
    // Both drains really took part.
    expect(a.done).toBeGreaterThan(0);
    expect(b.done).toBeGreaterThan(0);
  });

  it("takes only its own kind, only due jobs, oldest due first, at most `max`", { timeout: SLOW }, async () => {
    await enqueue("work", { n: "later" }, { ...opts(), runAfter: new Date(clock.getTime() + 10 * MINUTE) });
    await enqueue("other", { n: "other" }, opts());
    await enqueue("work", { n: "second" }, { ...opts(), runAfter: new Date(clock.getTime() - 1 * MINUTE) });
    await enqueue("work", { n: "first" }, { ...opts(), runAfter: new Date(clock.getTime() - 5 * MINUTE) });
    await enqueue("work", { n: "third" }, opts());

    const seen: unknown[] = [];
    const handler = (p: { n?: string }) => void seen.push(p.n);
    expect(await drain("work", handler, { ...opts(), max: 2 })).toEqual({ done: 2, retried: 0, failed: 0 });
    expect(seen).toEqual(["first", "second"]);
    expect(await drain("work", handler, opts())).toEqual({ done: 1, retried: 0, failed: 0 });
    expect(seen).toEqual(["first", "second", "third"]);

    advance(10 * MINUTE);
    await drain("work", handler, opts());
    expect(seen).toEqual(["first", "second", "third", "later"]);
    expect((await allJobs()).filter((r) => r.status === "queued").map((r) => r.kind)).toEqual(["other"]);
  });

  it("starts no new job once the time budget is used up", { timeout: SLOW }, async () => {
    for (let i = 0; i < 3; i++) await enqueue("work", { i }, opts());
    const result = await drain("work", () => advance(6_000), { ...opts(), budgetMs: 10_000 });
    expect(result.done).toBe(2);
    expect((await allJobs()).map((r) => r.status).sort()).toEqual(["done", "done", "queued"]);
  });

  it("retries a failing job after 1, 5, 30 and 30 minutes, then marks it failed", { timeout: SLOW }, async () => {
    expect(MAX_TRIES).toBe(5);
    expect(BACKOFF_MINUTES).toEqual([1, 5, 30, 30]);
    const { id } = await enqueue("work", {}, opts());
    const attemptsSeen: number[] = [];
    const handler = (_p: unknown, job: { attempt: number }) => {
      attemptsSeen.push(job.attempt);
      throw new Error(`boom ${job.attempt}`);
    };

    for (const [i, minutes] of BACKOFF_MINUTES.entries()) {
      expect(await drain("work", handler, opts())).toEqual({ done: 0, retried: 1, failed: 0 });
      const row = await jobById(id);
      expect(row).toMatchObject({ status: "queued", attempts: i + 1, lastError: `Error: boom ${i + 1}` });
      expect(row.runAfter.getTime() - clock.getTime()).toBe(minutes * MINUTE);

      // Not before the wait is over...
      advance(minutes * MINUTE - 1);
      expect(await drain("work", handler, opts())).toEqual({ done: 0, retried: 0, failed: 0 });
      // ...and then it is due again.
      advance(1);
    }

    expect(await drain("work", handler, opts())).toEqual({ done: 0, retried: 0, failed: 1 });
    expect(await jobById(id)).toMatchObject({ status: "failed", attempts: 5, lastError: "Error: boom 5" });
    expect(attemptsSeen).toEqual([1, 2, 3, 4, 5]);

    // Failed is final.
    advance(24 * 60 * MINUTE);
    expect(await drain("work", handler, opts())).toEqual({ done: 0, retried: 0, failed: 0 });
    expect(attemptsSeen).toHaveLength(5);
    expect(await dueKinds(opts())).toEqual([]);
  });

  it("a job that fails once and then works ends done", { timeout: SLOW }, async () => {
    const { id } = await enqueue("work", {}, opts());
    let calls = 0;
    const handler = () => {
      if (++calls === 1) throw new Error("first time unlucky");
    };
    await drain("work", handler, opts());
    advance(1 * MINUTE);
    expect(await drain("work", handler, opts())).toEqual({ done: 1, retried: 0, failed: 0 });
    expect(await jobById(id)).toMatchObject({ status: "done", attempts: 2 });
  });

  it("takes back a job left running by a tick that died, once its lease is over", { timeout: SLOW }, async () => {
    const { id } = await enqueue("work", {}, opts());
    // A tick that claims the job and then dies: its handler never returns.
    let started!: () => void;
    const reached = new Promise<void>((r) => (started = r));
    void drain("work", () => (started(), new Promise<void>(() => {})), opts());
    await reached;
    expect(await jobById(id)).toMatchObject({ status: "running", attempts: 1 });

    const seen: number[] = [];
    const handler = (_p: unknown, job: { attempt: number }) => void seen.push(job.attempt);
    advance(LEASE_MS - 1);
    expect(await drain("work", handler, opts())).toEqual({ done: 0, retried: 0, failed: 0 });
    advance(1);
    expect(await dueKinds(opts())).toEqual(["work"]);
    expect(await drain("work", handler, opts())).toEqual({ done: 1, retried: 0, failed: 0 });
    expect(seen).toEqual([2]);
    expect(await jobById(id)).toMatchObject({ status: "done", attempts: 2 });
  });

  it("ignores a late finish from a run whose job was taken back", { timeout: SLOW }, async () => {
    const { id } = await enqueue("work", {}, opts());
    let release!: () => void;
    let started!: () => void;
    const reached = new Promise<void>((r) => (started = r));
    const slow = drain("work", () => (started(), new Promise<void>((r) => (release = r))), opts());
    await reached;

    advance(LEASE_MS);
    await drain(
      "work",
      () => {
        throw new Error("second try failed");
      },
      opts(),
    );
    release();
    await slow;
    // The slow first run's "done" did not overwrite the second try's result.
    expect(await jobById(id)).toMatchObject({ status: "queued", attempts: 2, lastError: "Error: second try failed" });
  });

  it("marks a job failed when a tick died on its fifth try", { timeout: SLOW }, async () => {
    const { id } = await enqueue("work", {}, opts());
    await t.db
      .update(jobs)
      .set({ status: "running", attempts: 5, runAfter: new Date(clock.getTime() - 1) })
      .where(eq(jobs.id, id));
    const handler = vi.fn();
    expect(await drain("work", handler, opts())).toEqual({ done: 0, retried: 0, failed: 1 });
    expect(handler).not.toHaveBeenCalled();
    const row = await jobById(id);
    expect(row.status).toBe("failed");
    expect(row.lastError).toMatch(/try 5/);
  });
});

describe("dueKinds", () => {
  it("lists each kind with due work once", { timeout: SLOW }, async () => {
    await enqueue("b-kind", {}, opts());
    await enqueue("b-kind", {}, opts());
    await enqueue("a-kind", {}, opts());
    await enqueue("later", {}, { ...opts(), runAfter: new Date(clock.getTime() + MINUTE) });
    expect(await dueKinds(opts())).toEqual(["a-kind", "b-kind"]);
    await drain("a-kind", () => {}, opts());
    expect(await dueKinds(opts())).toEqual(["b-kind"]);
  });
});

describe("GET/POST /api/cron/tick", () => {
  const URL_ = "https://ready.test/api/cron/tick";
  const call = async (method: "GET" | "POST", headers: Record<string, string> = {}) => {
    const route = await import("@/app/api/cron/tick/route");
    return route[method](new Request(URL_, { method, headers }));
  };
  const bearer = { authorization: `Bearer ${TEST_SECRET}` };

  it("answers 401 without the secret, and calls nothing", { timeout: SLOW }, async () => {
    vi.stubEnv("CRON_SECRET", TEST_SECRET);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await enqueue("work", {}, { db: t.db });

    for (const method of ["GET", "POST"] as const) {
      const attempts: Record<string, string>[] = [
        {},
        { authorization: "" },
        { authorization: "Bearer" },
        { authorization: "Bearer wrong" },
        { authorization: `Bearer ${TEST_SECRET}x` },
        { authorization: `bearer ${TEST_SECRET}` },
        { authorization: TEST_SECRET },
        { authorization: `Basic ${TEST_SECRET}` },
      ];
      for (const headers of attempts) {
        const res = await call(method, headers);
        expect(res.status).toBe(401);
        expect(await res.text()).not.toContain(TEST_SECRET);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 401 to everyone when CRON_SECRET is not set", { timeout: SLOW }, async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const secret of [undefined, ""]) {
      vi.stubEnv("CRON_SECRET", secret);
      const attempts: Record<string, string>[] = [
        {},
        { authorization: "Bearer " },
        { authorization: "Bearer undefined" },
        bearer,
      ];
      for (const headers of attempts) {
        expect((await call("POST", headers)).status).toBe(401);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with the secret, calls each due kind's own route with the same header", { timeout: SLOW }, async () => {
    vi.stubEnv("CRON_SECRET", TEST_SECRET);
    await enqueue("lecture-pages", {}, { db: t.db });
    await enqueue("lecture-pages", {}, { db: t.db });
    await enqueue("cards", {}, { db: t.db });
    await enqueue("not-yet", {}, { db: t.db, runAfter: new Date(Date.now() + 60 * MINUTE) });
    // A kind written by something other than enqueue: never put into a URL.
    await t.db.insert(jobs).values({ kind: "../../admin" });

    const fetchMock = vi.fn(async (...[url]: [string, RequestInit]) =>
      url.endsWith("/cards") ? new Response("nope", { status: 500 }) : Response.json({ done: 2 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await call("GET", bearer);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      kinds: [
        { kind: "cards", status: 500, ok: false },
        { kind: "lecture-pages", status: 200, ok: true },
      ],
      skipped: ["../../admin"],
    });
    expect(text).not.toContain(TEST_SECRET);

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://ready.test/api/cron/cards",
      "https://ready.test/api/cron/lecture-pages",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TEST_SECRET}`);
      expect(init.redirect).toBe("manual");
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });

  it("with nothing due, answers ok and calls nothing; a kind it cannot reach is reported", { timeout: SLOW }, async () => {
    vi.stubEnv("CRON_SECRET", TEST_SECRET);
    const fetchMock = vi.fn(async () => {
      throw new Error("connection refused");
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await (await call("POST", bearer)).json()).toEqual({ ok: true, kinds: [], skipped: [] });
    expect(fetchMock).not.toHaveBeenCalled();

    await enqueue("work", {}, { db: t.db });
    const res = await call("POST", bearer);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, kinds: [{ kind: "work", status: 0, ok: false }], skipped: [] });
  });
});

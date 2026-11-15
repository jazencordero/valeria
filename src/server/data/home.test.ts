// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { cardConcepts, cards, concepts, exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";

// The exam cards and the bite row read M3-18's `examView`, which takes the user
// from the session cookie and uses the app's `db`. Both are swapped for the
// test's, as in `actions.test.ts`: `signedIn.userId` is who the cookie says.
const signedIn = vi.hoisted(() => ({ userId: "", db: null as unknown as Record<string | symbol, unknown> }));

vi.mock("@/server/auth/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/auth/session")>();
  return {
    ...real,
    currentUser: async () => {
      if (!signedIn.userId) throw new real.NotSignedIn();
      return { id: signedIn.userId };
    },
  };
});

vi.mock("@/server/db/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db/client")>();
  const db = new Proxy(
    {},
    {
      get(_, key) {
        const v = signedIn.db[key];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(signedIn.db) : v;
      },
    },
  );
  return { ...real, db };
});

const { biteDay, biteFor, firstNameOf, getHomeView } = await import("./home");
const { beginSession, endSession, saveProgress } = await import("@/server/study/actions");

const DB_TIMEOUT = 90_000;

const NOW = new Date("2026-11-14T15:48:00+02:00");
const CONNECTED = new Date("2026-11-10T10:00:00+02:00");

let t: TestDb;
let moodleId = 1;

beforeEach(async () => {
  t = await createTestDb();
  signedIn.db = t.db as unknown as Record<string | symbol, unknown>;
  signedIn.userId = "";
}, DB_TIMEOUT);
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
}, DB_TIMEOUT);

async function user(
  opts: { connected?: boolean; status?: "ok" | "expired" | "revoked" | "error"; name?: string | null } = {},
) {
  const { connected = true, status = "ok", name = null } = opts;
  const [u] = await t.db.insert(users).values({ displayName: name }).returning();
  if (connected) {
    await t.db.insert(moodleConnections).values({
      userId: u.id,
      siteUrl: "https://moodle.example",
      moodleUserId: moodleId++,
      tokenSealed: "sealed",
      connectedAt: CONNECTED,
      status,
    });
  }
  return u;
}

async function course(userId: string, name: string, extra: Partial<typeof courses.$inferInsert> = {}) {
  const [c] = await t.db
    .insert(courses)
    .values({ userId, moodleId: moodleId++, name, ...extra })
    .returning();
  return c;
}

async function assignment(
  userId: string,
  courseId: string,
  name: string,
  extra: Partial<typeof assignments.$inferInsert> = {},
) {
  const [a] = await t.db
    .insert(assignments)
    .values({ userId, courseId, moodleId: moodleId++, name, firstSeenAt: CONNECTED, ...extra })
    .returning();
  return a;
}

describe("getHomeView", () => {
  it("puts the earliest due first and the rest under Then, in order", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods", { code: "ISM-E1005" });
    const sca = await course(u.id, "Supply Chain Analytics", { code: "ISM-E3003" });
    await assignment(u.id, sca.id, "No date");
    await assignment(u.id, sca.id, "Case memo 2", { dueAt: new Date("2026-11-17T23:59:00+02:00") });
    const a3 = await assignment(u.id, fm.id, "Assignment 3: Forecast weekly demand", {
      dueAt: new Date("2026-11-14T21:00:00+02:00"),
      estimateMin: 90,
    });
    await assignment(u.id, fm.id, "Blueprint", { dueAt: new Date("2026-11-19T16:00:00+02:00") });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.first).toMatchObject({
      id: a3.id,
      title: "Assignment 3: Forecast weekly demand",
      course: "Forecasting Methods",
      code: "ISM-E1005",
      estimateMin: 90,
      status: "not_started",
      href: `/assignments/${a3.id}`,
    });
    expect(view.first?.dueAt?.toISOString()).toBe("2026-11-14T19:00:00.000Z");
    expect(view.then.map((a) => a.title)).toEqual(["Case memo 2", "Blueprint", "No date"]);
    expect(view.then[0]).toMatchObject({ course: "Supply Chain Analytics", status: "not_started" });
  });

  it("gives a null code when the course has none", async () => {
    const u = await user();
    const c = await course(u.id, "No code");
    await assignment(u.id, c.id, "Essay", { dueAt: new Date("2026-11-20T12:00:00+02:00") });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.first).toMatchObject({ title: "Essay", code: null });
    expect(view.then).toEqual([]);
  });

  it("gives the newest hand-in of the last 7 days, with its due time, when nothing is open", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    await assignment(u.id, fm.id, "Long ago", { submittedAt: new Date("2026-10-01T10:00:00+03:00") });
    await assignment(u.id, fm.id, "Tuesday", { submittedAt: new Date("2026-11-10T10:00:00+02:00") });
    const a3 = await assignment(u.id, fm.id, "Assignment 3", {
      submittedAt: new Date("2026-11-14T15:52:00+02:00"),
      dueAt: new Date("2026-11-14T21:00:00+02:00"),
      state: "submitted",
    });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.first).toBeNull();
    expect(view.then).toEqual([]);
    expect(view.lastDone).toMatchObject({ id: a3.id, title: "Assignment 3", course: "Forecasting Methods" });
    expect(view.lastDone?.submittedAt.toISOString()).toBe("2026-11-14T13:52:00.000Z");
    expect(view.lastDone?.dueAt?.toISOString()).toBe("2026-11-14T19:00:00.000Z");
  });

  it("gives no done row when the newest hand-in is older than 7 days", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    await assignment(u.id, fm.id, "Old", { submittedAt: new Date("2026-11-07T15:00:00+02:00") });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.first).toBeNull();
    expect(view.lastDone).toBeNull();
  });

  it("leaves out another user's assignments", async () => {
    const u = await user();
    const other = await user();
    const mine = await course(u.id, "Mine");
    const theirs = await course(other.id, "Theirs");
    await assignment(u.id, mine.id, "My memo", { dueAt: new Date("2026-11-18T12:00:00+02:00") });
    await assignment(other.id, theirs.id, "Their earlier one", { dueAt: new Date("2026-11-15T12:00:00+02:00") });
    await assignment(other.id, theirs.id, "Their done", { submittedAt: new Date("2026-11-14T10:00:00+02:00") });
    // Their row in my course still is not mine.
    await assignment(other.id, mine.id, "Their row", { dueAt: new Date("2026-11-15T09:00:00+02:00") });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.first?.title).toBe("My memo");
    expect(view.then).toEqual([]);
    expect(view.lastDone).toBeNull();
  });

  it("leaves out hidden courses and their assignments", async () => {
    const u = await user();
    const shown = await course(u.id, "Shown");
    const old = await course(u.id, "Old course", { hidden: true });
    await assignment(u.id, old.id, "Hidden first", { dueAt: new Date("2026-11-15T09:00:00+02:00") });
    await assignment(u.id, old.id, "Hidden done", { submittedAt: new Date("2026-11-14T10:00:00+02:00") });
    await assignment(u.id, shown.id, "Shown one", { dueAt: new Date("2026-11-18T12:00:00+02:00") });
    await assignment(u.id, shown.id, "Shown two", { dueAt: new Date("2026-11-19T12:00:00+02:00") });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.first?.title).toBe("Shown one");
    expect(view.then.map((a) => a.title)).toEqual(["Shown two"]);
    expect(view.lastDone).toBeNull();
  });

  it("gives the connection status, or null when she never connected", async () => {
    const ok = await user();
    const expired = await user({ status: "expired" });
    const none = await user({ connected: false });

    expect((await getHomeView(ok.id, { now: NOW }, t.db)).connection).toEqual({ status: "ok" });
    expect((await getHomeView(expired.id, { now: NOW }, t.db)).connection).toEqual({ status: "expired" });
    expect((await getHomeView(none.id, { now: NOW }, t.db)).connection).toBeNull();
  });

  it("gives her first name, or null when there is none", async () => {
    const named = await user({ name: "  Valeria Example " });
    const unnamed = await user();

    expect((await getHomeView(named.id, { now: NOW }, t.db)).firstName).toBe("Valeria");
    expect((await getHomeView(unnamed.id, { now: NOW }, t.db)).firstName).toBeNull();
  });
});

/** An exam with 3 concepts of 4 cards each: enough for two bites today. */
async function exam(
  userId: string,
  courseId: string,
  title: string,
  at: Date,
  opts: { kind?: "exam" | "quiz"; cards?: boolean; startNewOn?: string } = {},
) {
  const { kind = "exam", cards: withCards = true, startNewOn } = opts;
  const [e] = await t.db
    .insert(exams)
    .values({ userId, courseId, title, kind, at, ...(startNewOn ? { startNewOn } : {}) })
    .returning();
  if (!withCards) return e;
  const made = await t.db
    .insert(concepts)
    .values([1, 2, 3].map((p) => ({ userId, examId: e.id, name: `Concept ${p}`, position: p, weight: 1 })))
    .returning();
  for (const [i, concept] of made.entries()) {
    for (let k = 0; k < 4; k++) {
      const [card] = await t.db
        .insert(cards)
        .values({
          userId,
          examId: e.id,
          type: "basic",
          rung: 1 + (k % 3),
          body: { front: `Q${i}.${k}`, back: "A" },
          origin: "manual",
          contentHash: `${e.id}-${i}-${k}`,
        })
        .returning();
      await t.db.insert(cardConcepts).values({ cardId: card.id, conceptId: concept.id });
    }
  }
  return e;
}

/** Plays today's bite for an exam to the end, every card "Got it", through the session actions. */
async function playBite(examId: string) {
  const begun = await beginSession(examId, "bite");
  expect(begun).not.toBeNull();
  let clock = Date.now();
  for (const c of begun!.cards) {
    clock += 20_000;
    vi.setSystemTime(new Date(clock));
    await saveProgress(begun!.sessionId, [{ cardId: c.id, grade: 3, firstTry: true, ms: 20_000, at: new Date(clock) }]);
  }
  await endSession(begun!.sessionId);
  vi.setSystemTime(NOW);
}

// Friday 20 Nov 09:00 is 6 days after NOW (Saturday 14 Nov); Thursday 3 Dec is 19.
const FRIDAY = new Date("2026-11-20T09:00:00+02:00");
const DEC_3 = new Date("2026-12-03T09:00:00+02:00");

describe("getHomeView: bite row and exam cards", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it(
    "gives the bite row for the soonest exam with a bite",
    async () => {
      const u = await user();
      signedIn.userId = u.id;
      const fm = await course(u.id, "Forecasting Methods");
      await assignment(u.id, fm.id, "Memo", { dueAt: new Date("2026-11-17T23:59:00+02:00") });
      const later = await exam(u.id, fm.id, "Second exam", DEC_3);
      const soon = await exam(u.id, fm.id, "Forecasting exam", FRIDAY);

      const view = await getHomeView(u.id, { now: NOW }, t.db);

      expect(view.bite).toMatchObject({
        state: "bite",
        examId: soon.id,
        forWhat: "Friday\u2019s exam",
        href: `/study/new?exam=${soon.id}&kind=bite`,
      });
      const bite = view.bite as Extract<typeof view.bite, { state: "bite" }>;
      expect(bite.cards).toBeGreaterThan(0);
      expect(bite.minutes).toBe(Math.max(2, Math.round(bite.cards * 0.6)));
      expect(bite.gain).toBe(Math.max(2, Math.round(bite.cards * 0.85)));
      // An assignment is open, so the bite stays under DO FIRST.
      expect(view.biteFirst).toBe(false);
      expect(view.exams.map((e) => e.id)).toEqual([soon.id, later.id]);
      expect(view.exams[0]).toMatchObject({ biteMinutes: bite.minutes, grade: 4, href: `/exams/${soon.id}` });
    },
    DB_TIMEOUT,
  );

  it(
    "reads 'Today's bites are done' once both of today's bites are played, and moves to the next exam's bite",
    async () => {
      const u = await user();
      signedIn.userId = u.id;
      const fm = await course(u.id, "Forecasting Methods");
      const friday = await exam(u.id, fm.id, "Forecasting exam", FRIDAY);

      await playBite(friday.id);
      const mid = await getHomeView(u.id, { now: NOW }, t.db);
      expect(mid.bite).toMatchObject({ state: "bite", examId: friday.id });

      await playBite(friday.id);
      const done = await getHomeView(u.id, { now: NOW }, t.db);
      expect(done.bite).toMatchObject({ state: "done", examId: friday.id, day: "FRIDAY", href: `/exams/${friday.id}` });
      const d = done.bite as Extract<typeof done.bite, { state: "done" }>;
      expect(d.forecast).toBe(done.exams[0].forecast);
      expect(d.forecast).toBeGreaterThan(0);
      expect(done.exams[0].biteMinutes).toBeNull();
      expect(done.biteFirst).toBe(false);

      // A later exam that still has a bite today takes the row.
      const later = await exam(u.id, fm.id, "Second exam", DEC_3);
      const next = await getHomeView(u.id, { now: NOW }, t.db);
      expect(next.bite).toMatchObject({ state: "bite", examId: later.id, forWhat: "the exam on 3 Dec" });
    },
    DB_TIMEOUT,
  );

  it(
    "makes the bite the DO FIRST card when nothing is open",
    async () => {
      const u = await user();
      signedIn.userId = u.id;
      const fm = await course(u.id, "Forecasting Methods");
      await assignment(u.id, fm.id, "Handed in", { submittedAt: new Date("2026-11-13T10:00:00+02:00") });
      await exam(u.id, fm.id, "Forecasting exam", FRIDAY);

      const view = await getHomeView(u.id, { now: NOW }, t.db);

      expect(view.first).toBeNull();
      expect(view.bite?.state).toBe("bite");
      expect(view.biteFirst).toBe(true);
    },
    DB_TIMEOUT,
  );

  it(
    "gives no row when no exam has cards, or before the study start",
    async () => {
      const u = await user();
      signedIn.userId = u.id;
      const fm = await course(u.id, "Forecasting Methods");
      await exam(u.id, fm.id, "No cards yet", FRIDAY, { cards: false });
      await exam(u.id, fm.id, "Starts later", DEC_3, { startNewOn: "2026-11-25" });

      const view = await getHomeView(u.id, { now: NOW }, t.db);

      expect(view.bite).toBeNull();
      expect(view.biteFirst).toBe(false);
      expect(view.exams.map((e) => e.title)).toEqual(["No cards yet", "Starts later"]);
      expect(view.exams.every((e) => e.biteMinutes === null)).toBe(true);
    },
    DB_TIMEOUT,
  );

  it(
    "lists exam cards soonest first, with past exams and hidden courses left out",
    async () => {
      const u = await user();
      signedIn.userId = u.id;
      const fm = await course(u.id, "Forecasting Methods");
      const old = await course(u.id, "Old course", { hidden: true });
      await exam(u.id, fm.id, "Later quiz", DEC_3, { kind: "quiz", cards: false });
      await exam(u.id, fm.id, "Past exam", new Date("2026-11-10T09:00:00+02:00"), { cards: false });
      await exam(u.id, old.id, "Hidden exam", new Date("2026-11-16T09:00:00+02:00"), { cards: false });
      await exam(u.id, fm.id, "Friday exam", FRIDAY, { cards: false });

      const view = await getHomeView(u.id, { now: NOW }, t.db);

      expect(view.exams.map((e) => e.title)).toEqual(["Friday exam", "Later quiz"]);
      expect(view.exams[1]).toMatchObject({ kind: "quiz", course: "Forecasting Methods", target: 80, grade: 4 });
      expect(view.exams[0].when).toBe("FRI 20 NOV · 09:00 · in 6 days");
    },
    DB_TIMEOUT,
  );
});

describe("biteFor and biteDay", () => {
  it("names the day within a week, the date beyond", () => {
    expect(biteFor("exam", FRIDAY, 6)).toBe("Friday\u2019s exam");
    expect(biteFor("quiz", FRIDAY, 1)).toBe("tomorrow\u2019s quiz");
    expect(biteFor("exam", FRIDAY, 0)).toBe("today\u2019s exam");
    expect(biteFor("exam", DEC_3, 19)).toBe("the exam on 3 Dec");
    expect(biteDay(FRIDAY, 6)).toBe("FRIDAY");
    expect(biteDay(DEC_3, 19)).toBe("3 DEC");
  });
});

describe("firstNameOf", () => {
  it("takes the first word, and null for blank", () => {
    expect(firstNameOf("Valeria Example")).toBe("Valeria");
    expect(firstNameOf("   ")).toBeNull();
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf(undefined)).toBeNull();
  });
});

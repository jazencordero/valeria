// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { gradeItems } from "@/server/db/schema/grades";
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
const { encodeFlash, FLASH_MAX_AGE_S, parseFlash } = await import("./flash");
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

// M4-10: the greeting, the NEW tag and the week.
const TONIGHT = new Date("2026-11-14T21:00:00+02:00");
const TUESDAY = new Date("2026-11-17T23:59:00+02:00");
const handedInFlash = { kind: "handedIn" as const, at: NOW };

describe("getHomeView: greeting", () => {
  it("names tonight's deadline and the day she is clear until", async () => {
    const u = await user({ name: "Valeria Example" });
    const fm = await course(u.id, "Forecasting Methods");
    await assignment(u.id, fm.id, "Assignment 3", { dueAt: TONIGHT });
    await assignment(u.id, fm.id, "Case memo 2", { dueAt: TUESDAY });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.greeting).toBe("Hi Valeria. Assignment 3 is due tonight, then you are clear until Tuesday.");
  });

  it("starts with 'Handed in' after a hand-in, naming what is next", async () => {
    const u = await user({ name: "Valeria Example" });
    const fm = await course(u.id, "Forecasting Methods");
    await assignment(u.id, fm.id, "Assignment 3", {
      dueAt: TONIGHT,
      submittedAt: new Date("2026-11-14T15:47:00+02:00"),
      state: "submitted",
    });
    await assignment(u.id, fm.id, "Case memo 2", { dueAt: TUESDAY });

    const view = await getHomeView(u.id, { now: NOW, flash: handedInFlash }, t.db);

    expect(view.greeting).toBe("Handed in, 5 hours early. Next up is Tuesday's Case memo 2.");
  });

  it("ignores a hand-in flash when there is no recent hand-in to name", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    await assignment(u.id, fm.id, "Case memo 2", { dueAt: TUESDAY });

    const view = await getHomeView(u.id, { now: NOW, flash: handedInFlash }, t.db);

    expect(view.greeting).toBe("Hi there. Nothing is due before Tuesday. A good day for a bite.");
  });

  it("says nothing open when nothing is", async () => {
    const u = await user({ name: "Valeria" });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.greeting).toBe("Hi Valeria. Nothing open. Enjoy it.");
  });
});

describe("getHomeView: greeting with exams", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it(
    "offers the bite row's exam after the next task",
    async () => {
      const u = await user({ name: "Valeria" });
      signedIn.userId = u.id;
      const fm = await course(u.id, "Forecasting Methods");
      await assignment(u.id, fm.id, "Assignment 3", {
        dueAt: TONIGHT,
        submittedAt: new Date("2026-11-14T15:47:00+02:00"),
      });
      await assignment(u.id, fm.id, "memo", { dueAt: TUESDAY });
      await exam(u.id, fm.id, "Forecasting exam", FRIDAY);

      const view = await getHomeView(u.id, { now: NOW, flash: handedInFlash }, t.db);

      expect(view.greeting).toBe(
        "Handed in, 5 hours early. Next up is Tuesday's memo, or a 5-minute bite for Friday's exam.",
      );
    },
    DB_TIMEOUT,
  );

  it(
    "says the new forecast after a session, and ignores one for an exam not on Home",
    async () => {
      const u = await user({ name: "Valeria" });
      signedIn.userId = u.id;
      const fm = await course(u.id, "Forecasting Methods");
      const friday = await exam(u.id, fm.id, "Forecasting exam", FRIDAY, { cards: false });

      const studied = { kind: "studied" as const, at: NOW, examId: friday.id, forecast: 67.6 };
      const view = await getHomeView(u.id, { now: NOW, flash: studied }, t.db);
      expect(view.greeting).toBe("Nice. Friday's exam forecast is up to 68%.");

      const other = { ...studied, examId: "00000000-0000-4000-8000-000000000000" };
      const plain = await getHomeView(u.id, { now: NOW, flash: other }, t.db);
      expect(plain.greeting).toBe("Hi Valeria. Nothing open. Enjoy it.");
    },
    DB_TIMEOUT,
  );
});

describe("getHomeView: NEW tag", () => {
  it("marks a row New when it arrived after the first sync and she has not opened it", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    await assignment(u.id, fm.id, "First", { dueAt: TONIGHT });
    await assignment(u.id, fm.id, "Arrived today", {
      dueAt: TUESDAY,
      firstSeenAt: new Date("2026-11-14T09:00:00+02:00"),
    });
    await assignment(u.id, fm.id, "Opened", {
      dueAt: new Date("2026-11-18T12:00:00+02:00"),
      firstSeenAt: new Date("2026-11-14T09:00:00+02:00"),
      seenAt: new Date("2026-11-14T10:00:00+02:00"),
    });
    await assignment(u.id, fm.id, "From the first sync", { dueAt: new Date("2026-11-19T12:00:00+02:00") });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.then.map((a) => [a.title, a.status])).toEqual([
      ["Arrived today", "new"],
      ["Opened", "not_started"],
      ["From the first sync", "not_started"],
    ]);
  });
});

describe("getHomeView: week", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it(
    "marks today, deadlines, hand-ins and exams on the 7 days, and lists what is ahead",
    async () => {
      const u = await user();
      signedIn.userId = u.id;
      const fm = await course(u.id, "Forecasting Methods");
      const old = await course(u.id, "Old course", { hidden: true });
      await assignment(u.id, fm.id, "Assignment 3", { dueAt: TONIGHT });
      await assignment(u.id, fm.id, "Case memo 2", { dueAt: TUESDAY });
      await assignment(u.id, fm.id, "Early one", {
        dueAt: new Date("2026-11-19T16:00:00+02:00"),
        submittedAt: new Date("2026-11-13T10:00:00+02:00"),
      });
      await assignment(u.id, fm.id, "Far away", { dueAt: new Date("2026-11-25T12:00:00+02:00") });
      await assignment(u.id, fm.id, "Yesterday's", { dueAt: new Date("2026-11-13T12:00:00+02:00") });
      await assignment(u.id, old.id, "Hidden", { dueAt: new Date("2026-11-16T12:00:00+02:00") });
      await exam(u.id, fm.id, "Forecasting exam", FRIDAY, { cards: false });

      const { week } = await getHomeView(u.id, { now: NOW }, t.db);

      expect(week.days.map((d) => `${d.weekday} ${d.day} ${d.marker ?? "-"}`)).toEqual([
        "SAT 14 due_today",
        "SUN 15 -",
        "MON 16 -",
        "TUE 17 deadline",
        "WED 18 -",
        "THU 19 done",
        "FRI 20 exam",
      ]);
      expect(week.agenda.map((r) => `${r.date} ${r.title}`)).toEqual([
        "TUE 17 Case memo 2",
        "FRI 20 Forecasting exam",
      ]);
      expect(week.line).toBe("Nothing else is due before Tuesday.");
    },
    DB_TIMEOUT,
  );

  it("says nothing is due when the week is empty", async () => {
    const u = await user();

    const { week } = await getHomeView(u.id, { now: NOW }, t.db);

    expect(week.days).toHaveLength(7);
    expect(week.agenda).toEqual([]);
    expect(week.line).toBe("Nothing due this week.");
  });
});

describe("getHomeView: grades card", () => {
  async function item(
    userId: string,
    courseId: string,
    name: string,
    extra: Partial<typeof gradeItems.$inferInsert> = {},
  ) {
    await t.db
      .insert(gradeItems)
      .values({ userId, courseId, moodleRef: `ref-${moodleId++}`, name, max: 100, ...extra });
  }

  it("gives one row per visible course, by name, linking to its grade page", async () => {
    const u = await user();
    const sca = await course(u.id, "Supply Chain Analytics", { target: 4 });
    const fm = await course(u.id, "Forecasting Methods");
    const hidden = await course(u.id, "Old course", { hidden: true });
    // Forecasting: half graded at 80%, the rest assumed the same: heading for a 4, aiming for 5.
    await item(u.id, fm.id, "Assignment 1", { weight: 0.5, score: 80, position: 0 });
    await item(u.id, fm.id, "Exam", { weight: 0.5, position: 1 });
    // Supply chain: nothing graded yet.
    await item(u.id, sca.id, "Case memo 1", { weight: 1 });
    await item(u.id, hidden.id, "Old exam", { weight: 1, score: 90 });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.grades).toHaveLength(2);
    expect(view.grades[0]).toMatchObject({
      id: fm.id,
      href: `/grades/${fm.id}`,
      name: "Forecasting Methods",
      status: "within",
      target: 5,
    });
    expect(view.grades[0].trajectory).toBeCloseTo(4, 6);
    expect(view.grades[1]).toMatchObject({
      id: sca.id,
      href: `/grades/${sca.id}`,
      status: "early",
      target: 4,
      trajectory: null,
    });
  });

  it("agrees with the Grades tab", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    await item(u.id, fm.id, "Assignment 1", { weight: 0.4, score: 72 });
    await item(u.id, fm.id, "Exam", { weight: 0.6 });
    await course(u.id, "Service Design");

    const { getGradesList } = await import("./grades");
    const view = await getHomeView(u.id, { now: NOW }, t.db);
    expect(view.grades).toEqual((await getGradesList(u.id, t.db)).courses);
  });

  it("leaves out another user's courses, and is empty without courses", async () => {
    const u = await user();
    const other = await user();
    const theirs = await course(other.id, "Their course");
    await item(other.id, theirs.id, "Exam", { weight: 1, score: 95 });

    const view = await getHomeView(u.id, { now: NOW }, t.db);
    expect(view.grades).toEqual([]);
  });
});

describe("parseFlash", () => {
  it("reads back what encodeFlash wrote", () => {
    expect(parseFlash(encodeFlash("handedIn", null, NOW), NOW)).toEqual({ kind: "handedIn", at: NOW });
    const studied = encodeFlash("studied", { examId: "e1", forecast: 68 }, NOW);
    expect(parseFlash(studied, new Date(NOW.getTime() + 30_000))).toEqual({
      kind: "studied",
      at: NOW,
      examId: "e1",
      forecast: 68,
    });
  });

  it("drops a note older than the max age, from the future, or malformed", () => {
    const raw = encodeFlash("handedIn", null, NOW);
    expect(parseFlash(raw, new Date(NOW.getTime() + FLASH_MAX_AGE_S * 1000 + 1))).toBeNull();
    expect(parseFlash(raw, new Date(NOW.getTime() - 60_000))).toBeNull();
    expect(parseFlash(undefined, NOW)).toBeNull();
    expect(parseFlash("not json", NOW)).toBeNull();
    expect(parseFlash(JSON.stringify({ kind: "handedIn" }), NOW)).toBeNull();
    expect(parseFlash(JSON.stringify({ kind: "studied", at: NOW.getTime(), examId: "e1" }), NOW)).toBeNull();
    expect(parseFlash(JSON.stringify({ kind: "other", at: NOW.getTime() }), NOW)).toBeNull();
  });
});

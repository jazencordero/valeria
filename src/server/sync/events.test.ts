// @vitest-environment node
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, newToken } from "@/server/auth/session";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { events } from "@/server/db/schema/calendar";
import { courses } from "@/server/db/schema/courses";
import { exams } from "@/server/db/schema/study";
import { NotAllowed } from "@/server/moodle/client";
import { ALLOWED_SITES, connectWithKey } from "@/server/moodle/connect";
import { DEMO_KEY } from "@/server/moodle/fake-inline";
import type { CalendarEvent, Quiz } from "@/server/moodle/read/calendar";
import { NotConnected, syncCourses } from "./courses";
import { EXAM_TARGET_PCT, HORIZON_DAYS, isExamTitle, kindFor, syncEvents, type SyncEventsDeps } from "./events";

// Made-up values for tests only. The fake Moodle accepts DEMO_KEY and nothing else.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const AALTO = ALLOWED_SITES[0];
// The machine can be busy; a fresh database per test takes a while.
const SLOW = 30_000;

const NOW = Date.parse("2026-11-15T08:00:00Z");
const DEC_1 = new Date("2026-12-01T10:00:00Z");
const DEC_10 = new Date("2026-12-10T09:00:00Z");
const DEC_15 = new Date("2026-12-15T09:00:00Z");
const NOV_1 = new Date("2026-11-01T10:00:00Z");

describe("isExamTitle", () => {
  it.each([
    "Final exam",
    "EXAM 1",
    "Exams week",
    "Written examination",
    "Midterm",
    "Mid-term test",
    "mid term quiz",
    "Finals",
    "Final",
    "Tentti",
    "tentti 12.12.",
    "Ilmoittaudu tenttiin",
    "Tentin tulokset",
    "Tentissä saa olla laskin",
    "Tenttejä on kaksi",
    "Välitentti 1",
    "Uusintatentti",
    "Uusintatentissä",
    "Exam (tentti) – Strategic IT",
  ])("says %j is an exam", (title) => {
    expect(isExamTitle(title)).toBe(true);
  });

  it.each([
    "Finally, the last lecture",
    "Finalize your group",
    "Worked examples",
    "Examine the case",
    "Pay attention to chapter 4",
    "Potential guest lecture",
    "Content update",
    "Tentative schedule",
    "Week 6 quiz closes",
    "Assignment 3 is due",
    "Luento 5",
    "",
  ])("says %j is not an exam", (title) => {
    expect(isExamTitle(title)).toBe(false);
  });
});

describe("kindFor", () => {
  it("makes assignments deadlines, exam words exams, quizzes quizzes, the rest other", () => {
    expect(kindFor("assign", "Final report")).toBe("deadline");
    expect(kindFor("quiz", "Midterm exam")).toBe("exam");
    expect(kindFor("quiz", "Week 6 quiz")).toBe("quiz");
    expect(kindFor("other", "Tentti")).toBe("exam");
    expect(kindFor("other", "Guest lecture")).toBe("other");
  });
});

describe("syncEvents", () => {
  let t: TestDb;
  beforeEach(async () => {
    vi.stubEnv("MOODLE_FAKE", "1");
    vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
    t = await createTestDb();
  }, SLOW);
  afterEach(async () => {
    vi.unstubAllEnvs();
    await t.close();
  });

  /** A user with the fake Moodle connected and its four courses (3101-3104) synced. */
  async function connectedUser(): Promise<string> {
    const { user } = await ensureSessionFor(t.db, newToken());
    const result = await connectWithKey(user.id, AALTO, DEMO_KEY, t.db);
    if (!result.ok) throw new Error("the fake Moodle rejected the demo key");
    await syncCourses(result.userId, t.db);
    return result.userId;
  }

  const quiz = (id: number, course: number, name: string, closesAt: Date | null, opensAt: Date | null = null): Quiz => ({
    moodleRef: `quiz:${id}`,
    courseMoodleId: course,
    name,
    opensAt,
    closesAt,
  });
  const event = (id: number, course: number, title: string, startsAt: Date, module: CalendarEvent["module"]): CalendarEvent => ({
    moodleRef: `event:${id}`,
    courseMoodleId: course,
    title,
    startsAt,
    module,
    url: null,
  });

  /** Moodle's answers, which a test changes between syncs. `asked` records the calendar windows. */
  function fakeWith(start: { quizzes?: Quiz[]; calendar?: CalendarEvent[] } = {}) {
    const moodle = { quizzes: start.quizzes ?? [], calendar: start.calendar ?? [] };
    const asked = { windows: [] as { from: Date; to: Date }[], quizCourses: [] as number[][] };
    const deps: SyncEventsDeps = {
      now: () => NOW,
      getQuizzes: async (_conn, courseIds) => {
        asked.quizCourses.push([...courseIds].sort());
        return moodle.quizzes;
      },
      getUpcoming: async (_conn, range) => {
        asked.windows.push(range);
        return moodle.calendar;
      },
    };
    return { deps, moodle, asked };
  }

  async function eventsOf(userId: string) {
    return t.db.select().from(events).where(eq(events.userId, userId)).orderBy(asc(events.moodleRef));
  }
  async function examsOf(userId: string) {
    return t.db.select().from(exams).where(eq(exams.userId, userId)).orderBy(asc(exams.title));
  }

  it("makes a quiz and a 'Tentti' event exams once; a second sync adds nothing", async () => {
    const userId = await connectedUser();
    const { deps, asked } = fakeWith({
      quizzes: [quiz(8101, 3102, "Week 6 quiz", DEC_1)],
      calendar: [
        event(9101, 3101, "Assignment 3 is due", DEC_1, "assign"),
        // The calendar's copy of the quiz above: same course, same date.
        event(9102, 3102, "Week 6 quiz closes", DEC_1, "quiz"),
        event(9201, 3101, "Tentti", DEC_15, "other"),
        event(9301, 3103, "Guest lecture", DEC_10, "other"),
      ],
    });

    expect(await syncEvents(userId, t.db, deps)).toEqual({ added: 4, updated: 0, exams: 2 });
    expect(asked.windows).toEqual([{ from: new Date(NOW), to: new Date(NOW + HORIZON_DAYS * 24 * 60 * 60 * 1000) }]);
    expect(asked.quizCourses).toEqual([[3101, 3102, 3103, 3104]]);

    const rows = await eventsOf(userId);
    expect(rows.map((r) => [r.moodleRef, r.kind, r.title, r.source])).toEqual([
      ["event:9101", "deadline", "Assignment 3 is due", "moodle"],
      ["event:9201", "exam", "Tentti", "moodle"],
      ["event:9301", "other", "Guest lecture", "moodle"],
      ["quiz:8101", "quiz", "Week 6 quiz", "moodle"],
    ]);
    const byRef = new Map(rows.map((r) => [r.moodleRef, r]));

    const suggested = await examsOf(userId);
    expect(suggested).toHaveLength(2);
    expect(suggested[0]).toMatchObject({
      title: "Tentti",
      kind: "exam",
      at: DEC_15,
      targetPct: EXAM_TARGET_PCT,
      eventId: byRef.get("event:9201")!.id,
      courseId: byRef.get("event:9201")!.courseId,
    });
    expect(suggested[1]).toMatchObject({
      title: "Week 6 quiz",
      kind: "quiz",
      at: DEC_1,
      targetPct: 80,
      eventId: byRef.get("quiz:8101")!.id,
    });

    expect(await syncEvents(userId, t.db, deps)).toEqual({ added: 0, updated: 0, exams: 0 });
    expect(await eventsOf(userId)).toEqual(rows);
    expect(await examsOf(userId)).toEqual(suggested);
  }, SLOW);

  it("does not add again an exam she deleted, and keeps events Moodle stops returning", async () => {
    const userId = await connectedUser();
    const { deps, moodle } = fakeWith({ calendar: [event(9201, 3101, "Tentti", DEC_15, "other")] });
    await syncEvents(userId, t.db, deps);
    await t.db.delete(exams).where(eq(exams.userId, userId));

    expect(await syncEvents(userId, t.db, deps)).toEqual({ added: 0, updated: 0, exams: 0 });
    expect(await examsOf(userId)).toEqual([]);

    moodle.calendar = [];
    expect(await syncEvents(userId, t.db, deps)).toEqual({ added: 0, updated: 0, exams: 0 });
    expect((await eventsOf(userId)).map((r) => r.moodleRef)).toEqual(["event:9201"]);
  }, SLOW);

  it("suggests an exam once when a stored event is renamed into one", async () => {
    const userId = await connectedUser();
    const { deps, moodle } = fakeWith({ calendar: [event(9301, 3103, "Session 12", DEC_10, "other")] });
    expect(await syncEvents(userId, t.db, deps)).toEqual({ added: 1, updated: 0, exams: 0 });

    moodle.calendar = [event(9301, 3103, "Välitentti", DEC_10, "other")];
    expect(await syncEvents(userId, t.db, deps)).toEqual({ added: 0, updated: 1, exams: 1 });
    expect((await eventsOf(userId))[0].kind).toBe("exam");
    expect((await examsOf(userId)).map((e) => [e.title, e.kind])).toEqual([["Välitentti", "exam"]]);

    expect(await syncEvents(userId, t.db, deps)).toEqual({ added: 0, updated: 0, exams: 0 });
    expect(await examsOf(userId)).toHaveLength(1);
  }, SLOW);

  it("moves her exam with Moodle's date, unless she changed the date herself", async () => {
    const userId = await connectedUser();
    const { deps, moodle } = fakeWith({
      quizzes: [quiz(8101, 3102, "Week 6 quiz", DEC_1), quiz(8102, 3102, "Practice exam", DEC_1)],
    });
    await syncEvents(userId, t.db, deps);
    const [practice] = await t.db.select().from(exams).where(eq(exams.title, "Practice exam"));
    expect(practice.kind).toBe("exam");
    // She moved the practice exam to a day of her own.
    await t.db.update(exams).set({ at: DEC_10 }).where(eq(exams.id, practice.id));

    moodle.quizzes = [quiz(8101, 3102, "Week 6 quiz", DEC_15), quiz(8102, 3102, "Practice exam", DEC_15)];
    expect(await syncEvents(userId, t.db, deps)).toEqual({ added: 0, updated: 2, exams: 0 });
    const after = await examsOf(userId);
    expect(after.map((e) => [e.title, e.at])).toEqual([
      ["Practice exam", DEC_10],
      ["Week 6 quiz", DEC_15],
    ]);
    expect((await eventsOf(userId)).map((r) => r.startsAt)).toEqual([DEC_15, DEC_15]);
  }, SLOW);

  it("uses the open time of a quiz that never closes, and skips quizzes with no date or already over", async () => {
    const userId = await connectedUser();
    const { deps } = fakeWith({
      quizzes: [
        quiz(8201, 3101, "Open quiz", null, DEC_10),
        quiz(8202, 3101, "Any time quiz", null, null),
        quiz(8203, 3101, "Last month's quiz", NOV_1),
      ],
    });
    expect(await syncEvents(userId, t.db, deps)).toEqual({ added: 1, updated: 0, exams: 1 });
    expect((await eventsOf(userId)).map((r) => [r.moodleRef, r.startsAt])).toEqual([["quiz:8201", DEC_10]]);
  }, SLOW);

  it("skips courses she does not see and keeps a calendar quiz that getQuizzes did not return", async () => {
    const userId = await connectedUser();
    await t.db.update(courses).set({ hidden: true }).where(eq(courses.moodleId, 3104));
    const { deps, asked } = fakeWith({
      calendar: [
        event(9401, 3104, "Final exam", DEC_10, "other"),
        event(9402, 9999, "Tentti", DEC_10, "other"),
        event(9105, 3103, "Quiz 4 closes", DEC_10, "quiz"),
      ],
    });
    expect(await syncEvents(userId, t.db, deps)).toEqual({ added: 1, updated: 0, exams: 1 });
    expect(asked.quizCourses).toEqual([[3101, 3102, 3103]]);
    expect((await eventsOf(userId)).map((r) => [r.moodleRef, r.kind])).toEqual([["event:9105", "quiz"]]);
  }, SLOW);

  it("still syncs one source when her key may not call the other", async () => {
    const userId = await connectedUser();
    const { deps } = fakeWith({ quizzes: [quiz(8101, 3102, "Week 6 quiz", DEC_1)] });
    const noCalendar: SyncEventsDeps = {
      ...deps,
      getUpcoming: async () => {
        throw new NotAllowed("core_calendar_get_action_events_by_timesort", { errorcode: "accessexception" });
      },
    };
    expect(await syncEvents(userId, t.db, noCalendar)).toEqual({ added: 1, updated: 0, exams: 1 });
  }, SLOW);

  it("throws NotConnected for a user with no Moodle connection", async () => {
    const { user } = await ensureSessionFor(t.db, newToken());
    await expect(syncEvents(user.id, t.db, fakeWith().deps)).rejects.toBeInstanceOf(NotConnected);
  }, SLOW);
});

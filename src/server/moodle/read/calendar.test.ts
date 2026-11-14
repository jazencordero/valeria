// @vitest-environment node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeMoodle, type FakeMoodle } from "../../../../tests/fake-moodle/server";
import eventsSample from "../../../../tests/fixtures/moodle-sample/core_calendar_get_action_events_by_timesort.json";
import quizzesSample from "../../../../tests/fixtures/moodle-sample/mod_quiz_get_quizzes_by_courses.json";
import { MoodleError, NotAllowed, type MoodleConn } from "../client";
import { EVENTS_PAGE, MAX_EVENT_PAGES, getQuizzes, getUpcoming } from "./calendar";
import { UnexpectedAnswer } from "./site";

const FN_EVENTS = "core_calendar_get_action_events_by_timesort";
const FN_QUIZZES = "mod_quiz_get_quizzes_by_courses";

// Real answers recorded from her Moodle (M0), kept out of the repository.
const REAL_DIR = fileURLToPath(new URL("../../../../tests/fixtures/moodle/", import.meta.url));
const hasReal = (fn: string) => existsSync(`${REAL_DIR}${fn}.json`);

let moodle: FakeMoodle;
let conn: MoodleConn;

// A fresh fake per test, so an override never leaks into the next one. The
// calls go over HTTP through the real callMoodle, error mapping included.
beforeEach(async () => {
  vi.stubEnv("MOODLE_FAKE", "0");
  moodle = await startFakeMoodle();
  conn = { siteUrl: moodle.url, token: moodle.token };
});
afterEach(async () => {
  await moodle.close();
  vi.unstubAllEnvs();
});

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

const NOV_1 = new Date("2026-11-01T00:00:00Z");
const DEC_31 = new Date("2026-12-31T23:59:59Z");
const ALL = [3101, 3102, 3103, 3104];

// What Moodle answers for a function that is not in the key's service, with debugging on.
const ACCESS_DENIED = {
  exception: "webservice_access_exception",
  errorcode: "accessexception",
  message: "Access control exception",
  debuginfo: "Access to the function mod_quiz_get_quizzes_by_courses() is not allowed.",
};

describe("getUpcoming", () => {
  it("sends the window in Unix seconds with Moodle's largest page", async () => {
    await getUpcoming(conn, { from: NOV_1, to: DEC_31 });
    expect(moodle.calls).toHaveLength(1);
    expect(moodle.calls[0]).toMatchObject({
      fn: FN_EVENTS,
      params: { timesortfrom: "1793491200", timesortto: "1798761599", limitnum: "50" },
    });
    expect(moodle.calls[0].params).not.toHaveProperty("aftereventid");
  });

  it("reads the sample: course events only, dates as Dates", async () => {
    const events = await getUpcoming(conn, { from: NOV_1, to: DEC_31 });
    expect(events).toEqual([
      {
        moodleRef: "event:9101",
        courseMoodleId: 3101,
        title: "Assignment 3 is due",
        startsAt: new Date("2026-11-16T21:59:00Z"),
        module: "assign",
        url: "https://moodle.example.edu/mod/assign/view.php?id=5101",
      },
      {
        moodleRef: "event:9103",
        courseMoodleId: 3103,
        title: "Case memo 2 is due",
        startsAt: new Date("2026-11-17T21:59:00Z"),
        module: "assign",
        url: "https://moodle.example.edu/mod/assign/view.php?id=5301",
      },
      {
        moodleRef: "event:9102",
        courseMoodleId: 3102,
        title: "Week 6 quiz closes",
        startsAt: new Date("2026-11-20T10:00:00Z"),
        module: "quiz",
        url: "https://moodle.example.edu/mod/quiz/view.php?id=5201",
      },
      {
        moodleRef: "event:9104",
        courseMoodleId: 3104,
        title: "Peer feedback forum is due",
        startsAt: new Date("2026-11-25T21:59:00Z"),
        module: "other",
        url: "https://moodle.example.edu/mod/forum/view.php?id=5402",
      },
      {
        // No course object in the answer: the course id alone is enough.
        moodleRef: "event:9107",
        courseMoodleId: 3104,
        title: "Service blueprint is due",
        startsAt: new Date("2026-11-27T21:59:00Z"),
        module: "assign",
        url: "https://moodle.example.edu/mod/assign/view.php?id=5401",
      },
      {
        moodleRef: "event:9105",
        courseMoodleId: 3103,
        title: "Quiz 4 closes",
        startsAt: new Date("2026-12-04T21:59:00Z"),
        module: "quiz",
        url: "https://moodle.example.edu/mod/quiz/view.php?id=5302",
      },
    ]);
    for (const e of events) expect(e.startsAt).toBeInstanceOf(Date);
  });

  it("drops site, personal and category events, even with a course id", async () => {
    const base = eventsSample.events[0];
    moodle.override(FN_EVENTS, {
      body: {
        events: [
          { ...base, id: 1, eventtype: "site", courseid: 1, course: undefined },
          { ...base, id: 2, eventtype: "user", courseid: 0, course: undefined, modulename: null },
          { ...base, id: 3, eventtype: "category", courseid: 3101, course: undefined },
          { ...base, id: 4, eventtype: "course", courseid: null, course: null },
          { ...base, id: 5, eventtype: "due" },
        ],
      },
    });
    const events = await getUpcoming(conn, { from: NOV_1, to: DEC_31 });
    expect(events.map((e) => e.moodleRef)).toEqual(["event:5"]);
  });

  it("falls back to the action link and to timestart", async () => {
    const base = eventsSample.events[0];
    moodle.override(FN_EVENTS, {
      body: {
        events: [
          { ...base, url: undefined, timesort: undefined, timestart: 1795168800 },
          { ...base, id: 2, url: undefined, action: undefined },
        ],
      },
    });
    const [first, second] = await getUpcoming(conn, { from: NOV_1, to: DEC_31 });
    expect(first.url).toBe("https://moodle.example.edu/mod/assign/view.php?id=5101&action=editsubmission");
    expect(first.startsAt).toEqual(new Date("2026-11-20T10:00:00Z"));
    expect(second.url).toBeNull();
  });

  it("asks for the next page after a full one, up to the page cap", async () => {
    const base = eventsSample.events[0];
    const full = Array.from({ length: EVENTS_PAGE }, (_, i) => ({ ...base, id: 100 + i }));
    moodle.override(FN_EVENTS, { body: { events: full, firstid: 100, lastid: 100 + EVENTS_PAGE - 1 } });
    const events = await getUpcoming(conn, { from: NOV_1, to: DEC_31 });
    expect(moodle.calls).toHaveLength(MAX_EVENT_PAGES);
    expect(moodle.calls[1].params.aftereventid).toBe(String(100 + EVENTS_PAGE - 1));
    expect(events).toHaveLength(EVENTS_PAGE * MAX_EVENT_PAGES);
  });

  it("throws UnexpectedAnswer with the path, not the data, on a broken answer", async () => {
    const broken = structuredClone(eventsSample) as unknown as { events: Record<string, unknown>[] };
    broken.events[2].timestart = "Week 6 quiz closes soon";
    moodle.override(FN_EVENTS, { body: broken });
    const err = await caught(getUpcoming(conn, { from: NOV_1, to: DEC_31 }));
    expect(err).toBeInstanceOf(UnexpectedAnswer);
    const e = err as UnexpectedAnswer;
    expect(e.fn).toBe(FN_EVENTS);
    expect(e.path).toBe("events[2].timestart");
    expect(e.message).toContain("events[2].timestart");
    for (const value of ["Week 6 quiz", "9102", "3102", "5201"]) expect(e.message).not.toContain(value);
  });

  it.skipIf(!hasReal(FN_EVENTS))("reads the real answer", async () => {
    const real = await startFakeMoodle({ dir: REAL_DIR });
    try {
      const events = await getUpcoming(
        { siteUrl: real.url, token: real.token },
        { from: new Date(0), to: new Date("2100-01-01T00:00:00Z") },
      );
      for (const e of events) {
        expect(e.moodleRef).toMatch(/^event:\d+$/);
        expect(e.courseMoodleId).toBeGreaterThan(0);
        expect(Number.isNaN(e.startsAt.getTime())).toBe(false);
        expect(["assign", "quiz", "other"]).toContain(e.module);
      }
    } finally {
      await real.close();
    }
  });
});

describe("getQuizzes", () => {
  it("asks for the given courses and reads the sample", async () => {
    const quizzes = await getQuizzes(conn, ALL);
    expect(moodle.calls.at(-1)).toMatchObject({
      fn: FN_QUIZZES,
      params: { "courseids[0]": "3101", "courseids[1]": "3102", "courseids[2]": "3103", "courseids[3]": "3104" },
    });
    expect(quizzes).toEqual([
      {
        moodleRef: "quiz:8101",
        courseMoodleId: 3102,
        name: "Week 6 quiz",
        opensAt: new Date("2026-11-13T10:00:00Z"),
        closesAt: new Date("2026-11-20T10:00:00Z"),
      },
      {
        moodleRef: "quiz:8102",
        courseMoodleId: 3102,
        name: "Practice exam",
        opensAt: new Date("2026-12-01T08:00:00Z"),
        closesAt: new Date("2026-12-09T09:00:00Z"),
      },
      {
        // timeopen 0: open from the start.
        moodleRef: "quiz:8301",
        courseMoodleId: 3103,
        name: "Quiz 4",
        opensAt: null,
        closesAt: new Date("2026-12-04T21:59:00Z"),
      },
    ]);
  });

  it("reads missing times as null", async () => {
    const { timeopen, timeclose, ...rest } = quizzesSample.quizzes[0];
    void timeopen;
    void timeclose;
    moodle.override(FN_QUIZZES, { body: { quizzes: [rest], warnings: [] } });
    const [quiz] = await getQuizzes(conn, [3102]);
    expect(quiz).toMatchObject({ opensAt: null, closesAt: null });
  });

  it("returns [] without asking Moodle for no courses", async () => {
    expect(await getQuizzes(conn, [])).toEqual([]);
    expect(moodle.calls).toHaveLength(0);
  });

  it("returns [] when the function is not in her key's service", async () => {
    moodle.override(FN_QUIZZES, { body: ACCESS_DENIED });
    expect(await getQuizzes(conn, ALL)).toEqual([]);
    expect(moodle.calls).toHaveLength(1);
  });

  it("returns [] when Moodle does not have the function", async () => {
    const fresh = await startFakeMoodle({ dir: fileURLToPath(new URL("./", import.meta.url)) });
    try {
      // This folder has no answer files, so the fake answers as for an unknown function.
      expect(await getQuizzes({ siteUrl: fresh.url, token: fresh.token }, ALL)).toEqual([]);
    } finally {
      await fresh.close();
    }
  });

  it("throws other errors", async () => {
    moodle.override(FN_QUIZZES, {
      body: { exception: "moodle_exception", errorcode: "nopermissions", message: "Sorry, but you do not currently have permissions" },
    });
    const err = await caught(getQuizzes(conn, ALL));
    expect(err).toBeInstanceOf(MoodleError);
    expect(err).not.toBeInstanceOf(NotAllowed);
    expect((err as MoodleError).errorcode).toBe("nopermissions");
  });

  it("throws on a bad key instead of hiding it", async () => {
    moodle.rejectToken();
    const err = await caught(getQuizzes(conn, ALL));
    expect(err).toBeInstanceOf(MoodleError);
    expect(err).not.toBeInstanceOf(NotAllowed);
  });

  it("throws UnexpectedAnswer with the path, not the data, on a broken answer", async () => {
    const broken = structuredClone(quizzesSample) as unknown as { quizzes: Record<string, unknown>[] };
    broken.quizzes[1].timeclose = "Practice exam closes";
    moodle.override(FN_QUIZZES, { body: broken });
    const err = await caught(getQuizzes(conn, ALL));
    expect(err).toBeInstanceOf(UnexpectedAnswer);
    const e = err as UnexpectedAnswer;
    expect(e.fn).toBe(FN_QUIZZES);
    expect(e.path).toBe("quizzes[1].timeclose");
    for (const value of ["Practice exam", "8102", "3102"]) expect(e.message).not.toContain(value);
  });

  it.skipIf(!hasReal(FN_QUIZZES))("reads the real answer", async () => {
    const real = await startFakeMoodle({ dir: REAL_DIR });
    try {
      const quizzes = await getQuizzes({ siteUrl: real.url, token: real.token }, ALL);
      for (const q of quizzes) {
        expect(q.moodleRef).toMatch(/^quiz:\d+$/);
        expect(q.courseMoodleId).toBeGreaterThan(0);
        if (q.opensAt) expect(Number.isNaN(q.opensAt.getTime())).toBe(false);
        if (q.closesAt) expect(Number.isNaN(q.closesAt.getTime())).toBe(false);
      }
    } finally {
      await real.close();
    }
  });
});

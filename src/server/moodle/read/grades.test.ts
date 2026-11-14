// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeMoodle, type FakeMoodle } from "../../../../tests/fake-moodle/server";
import gradesSample from "../../../../tests/fixtures/moodle-sample/gradereport_user_get_grade_items.json";
import type { MoodleConn } from "../client";
import { getGradeItems } from "./grades";
import { UnexpectedAnswer } from "./site";

const FN = "gradereport_user_get_grade_items";
const COURSE = 3101;
const USER = 4242;

// Real answers recorded from her Moodle (M0), kept out of the repository.
const REAL_DIR = fileURLToPath(new URL("../../../../tests/fixtures/moodle/", import.meta.url));
const hasReal = existsSync(`${REAL_DIR}${FN}.json`);

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

type RawItem = Record<string, unknown>;
const sampleItems = gradesSample.usergrades[0].gradeitems as RawItem[];

function answerWith(items: RawItem[], userid = USER) {
  return { body: { usergrades: [{ courseid: COURSE, userid, gradeitems: items }], warnings: [] } };
}

describe("getGradeItems", () => {
  it("asks for one course and one user", async () => {
    await getGradeItems(conn, COURSE, USER);
    expect(moodle.calls).toHaveLength(1);
    expect(moodle.calls[0]).toMatchObject({ fn: FN, params: { courseid: "3101", userid: "4242" } });
  });

  it("reads the sample: five items, totals left out", async () => {
    const items = await getGradeItems(conn, COURSE, USER);
    expect(items.map((i) => i.moodleRef)).toEqual([
      "gradeitem:6101",
      "gradeitem:6102",
      "gradeitem:6103",
      "gradeitem:6104",
      "gradeitem:6105",
    ]);
    // The category total (6002) and the course total (6001) are not rows.
    expect(items.map((i) => i.moodleRef)).not.toContain("gradeitem:6001");
    expect(items.map((i) => i.moodleRef)).not.toContain("gradeitem:6002");
  });

  it("reads the three graded items with a Date, a percent and a weight", async () => {
    const [assign, quiz, manual] = await getGradeItems(conn, COURSE, USER);
    expect(assign).toEqual({
      moodleRef: "gradeitem:6101",
      name: "Assignment 1",
      kind: "assign",
      max: 20,
      score: 17,
      percent: 85,
      weight: 0.2,
      gradedAt: new Date("2026-09-28T14:30:00Z"),
      hidden: false,
    });
    expect(quiz).toEqual({
      moodleRef: "gradeitem:6102",
      name: "Week 3 quiz",
      kind: "quiz",
      max: 10,
      score: 7.5,
      percent: 75,
      weight: 0.1,
      gradedAt: new Date("2026-10-09T08:15:00Z"),
      hidden: false,
    });
    expect(manual).toEqual({
      moodleRef: "gradeitem:6103",
      name: "Midterm exam",
      kind: "manual",
      max: 100,
      score: 62,
      percent: 62,
      weight: 0.3,
      gradedAt: new Date("2026-10-30T16:00:00Z"),
      hidden: false,
    });
    for (const i of [assign, quiz, manual]) expect(i.gradedAt).toBeInstanceOf(Date);
  });

  it("reads ungraded items as nulls, and weight only when Moodle sends a number", async () => {
    const items = await getGradeItems(conn, COURSE, USER);
    const notYet = items[3];
    const forum = items[4];
    expect(notYet).toEqual({
      moodleRef: "gradeitem:6104",
      name: "Assignment 3",
      kind: "assign",
      max: 20,
      score: null,
      percent: null,
      // No weightraw in the answer at all.
      weight: null,
      gradedAt: null,
      hidden: false,
    });
    // weightraw is null in the answer; a forum is "other".
    expect(forum).toMatchObject({ kind: "other", score: null, percent: null, weight: null, gradedAt: null });
  });

  it("reads the hidden flag, including hidden until a date", async () => {
    const items = await getGradeItems(conn, COURSE, USER);
    expect(items.map((i) => i.hidden)).toEqual([false, false, false, false, true]);

    moodle.override(FN, answerWith([{ ...sampleItems[0], gradeishidden: undefined, gradehiddenbydate: true }]));
    const [byDate] = await getGradeItems(conn, COURSE, USER);
    expect(byDate.hidden).toBe(true);
  });

  it("computes the percent from the range, not from Moodle's text", async () => {
    moodle.override(
      FN,
      answerWith([
        // A non-zero minimum: (6 - 2) / (10 - 2) = 50 %, whatever the text says.
        { ...sampleItems[0], graderaw: 6, grademin: 2, grademax: 10, percentageformatted: "60,00 %" },
        // No range in the answer: no max and no percent, but the score stays.
        { ...sampleItems[1], grademin: undefined, grademax: undefined, percentageformatted: undefined },
        // An empty range cannot give a percent.
        { ...sampleItems[2], grademin: 0, grademax: 0 },
      ]),
    );
    const [ranged, noRange, empty] = await getGradeItems(conn, COURSE, USER);
    expect(ranged).toMatchObject({ score: 6, max: 10, percent: 50 });
    expect(noRange).toMatchObject({ score: 7.5, max: null, percent: null });
    expect(empty.percent).toBeNull();
  });

  it("keeps a scale item as its plain number on the scale", async () => {
    // A three-word scale: grademin 1, grademax 3, and she got the second word.
    moodle.override(FN, answerWith([{ ...sampleItems[0], scaleid: 12, graderaw: 2, grademin: 1, grademax: 3 }]));
    const [scale] = await getGradeItems(conn, COURSE, USER);
    expect(scale).toMatchObject({ score: 2, max: 3, percent: 50 });
  });

  it("keeps a weight of 0 (it is a real number) and the fraction as given", async () => {
    moodle.override(FN, answerWith([{ ...sampleItems[0], weightraw: 0 }, { ...sampleItems[1], weightraw: 0.125 }]));
    const [zero, eighth] = await getGradeItems(conn, COURSE, USER);
    expect(zero.weight).toBe(0);
    expect(eighth.weight).toBe(0.125);
  });

  it("reads a graded date of 0 as not graded", async () => {
    moodle.override(FN, answerWith([{ ...sampleItems[3], gradedategraded: 0 }]));
    const [item] = await getGradeItems(conn, COURSE, USER);
    expect(item.gradedAt).toBeNull();
  });

  it("keeps only her entry, and returns [] when she is not in the answer", async () => {
    moodle.override(FN, {
      body: {
        usergrades: [
          { courseid: COURSE, userid: 1, gradeitems: [sampleItems[0]] },
          { courseid: COURSE, userid: USER, gradeitems: [sampleItems[2]] },
        ],
      },
    });
    expect((await getGradeItems(conn, COURSE, USER)).map((i) => i.moodleRef)).toEqual(["gradeitem:6103"]);

    moodle.override(FN, answerWith([sampleItems[0]], 1));
    expect(await getGradeItems(conn, COURSE, USER)).toEqual([]);
  });

  it("throws UnexpectedAnswer with the path, not the data, on a broken answer", async () => {
    const broken = structuredClone(gradesSample) as unknown as { usergrades: { gradeitems: RawItem[] }[] };
    broken.usergrades[0].gradeitems[2].graderaw = "Midterm exam: 62 of 100";
    moodle.override(FN, { body: broken });
    const err = await caught(getGradeItems(conn, COURSE, USER));
    expect(err).toBeInstanceOf(UnexpectedAnswer);
    const e = err as UnexpectedAnswer;
    expect(e.fn).toBe(FN);
    expect(e.path).toBe("usergrades[0].gradeitems[2].graderaw");
    expect(e.message).toContain("usergrades[0].gradeitems[2].graderaw");
    for (const value of ["Midterm", "62", "6103", "4242", "3101"]) expect(e.message).not.toContain(value);
  });

  it.skipIf(!hasReal)("reads the real answer", async () => {
    const real = await startFakeMoodle({ dir: REAL_DIR });
    try {
      const recorded = JSON.parse(readFileSync(`${REAL_DIR}${FN}.json`, "utf8")) as {
        usergrades?: { courseid: number; userid: number }[];
      };
      const first = recorded.usergrades?.[0];
      expect(first).toBeDefined();
      if (!first) return;
      const items = await getGradeItems({ siteUrl: real.url, token: real.token }, first.courseid, first.userid);
      for (const i of items) {
        expect(i.moodleRef).toMatch(/^gradeitem:\d+$/);
        expect(["assign", "quiz", "manual", "other"]).toContain(i.kind);
        // Extra credit can take a grade past the maximum, so only check the numbers are real.
        if (i.percent !== null) expect(Number.isFinite(i.percent)).toBe(true);
        if (i.weight !== null) expect(i.weight).toBeGreaterThanOrEqual(0);
        if (i.gradedAt) expect(Number.isNaN(i.gradedAt.getTime())).toBe(false);
        expect(typeof i.hidden).toBe("boolean");
      }
    } finally {
      await real.close();
    }
  });
});

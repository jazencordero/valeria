// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import sample from "../../../../tests/fixtures/moodle-sample/core_enrol_get_users_courses.json";
import type { MoodleConn } from "../client";
import { DEMO_KEY } from "../fake-inline";
import { extractCode, getCourses } from "./courses";
import { UnexpectedAnswer } from "./site";

const fakeConn: MoodleConn = { siteUrl: "https://moodle.example.edu", token: DEMO_KEY };
const httpConn: MoodleConn = { siteUrl: "https://moodle.example.edu", token: "test-token" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Make Moodle answer `body` over (stubbed) HTTP; returns the fetch mock. */
function answerWith(body: unknown) {
  vi.stubEnv("MOODLE_FAKE", "0");
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    void url;
    void init;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("getCourses", () => {
  it("reads the sample answer from the fake Moodle", async () => {
    vi.stubEnv("MOODLE_FAKE", "1");
    const courses = await getCourses(fakeConn, 4242);
    expect(courses).toEqual([
      {
        moodleId: 3101,
        code: "ISM-E1005",
        name: "Forecasting Methods, Lecture, 1.9.2026-18.12.2026",
        shortName: "ISM-E1005 - Forecasting Methods",
      },
      {
        moodleId: 3102,
        code: "37E00200",
        name: "Strategic IT Management, Lecture, 1.9.2026-18.12.2026",
        shortName: "37E00200 - Strategic IT Management",
      },
      {
        moodleId: 3103,
        code: "ISM-E3003",
        name: "Supply Chain Analytics, Lecture, 1.9.2026-18.12.2026",
        shortName: "ISM-E3003 - Supply Chain Analytics",
      },
      {
        moodleId: 3104,
        code: "ISM-E2004",
        name: "Digital Service Design, Lecture, 1.9.2026-18.12.2026",
        shortName: "ISM-E2004 - Digital Service Design",
      },
    ]);
  });

  it("sends her user id", async () => {
    const fetchMock = answerWith(sample);
    await getCourses(httpConn, 4242);
    const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get("wsfunction")).toBe("core_enrol_get_users_courses");
    expect(body.get("userid")).toBe("4242");
  });

  it("falls back to the full name for the code, and to null", async () => {
    answerWith([
      { id: 1, shortname: "Forecasting", fullname: "Forecasting Methods (CS-A1110)" },
      { id: 2, shortname: "Orientation", fullname: "Orientation week" },
    ]);
    const courses = await getCourses(httpConn, 1);
    expect(courses.map((c) => c.code)).toEqual(["CS-A1110", null]);
  });

  it("throws UnexpectedAnswer with the path, not the data, on a broken answer", async () => {
    const broken = structuredClone(sample) as unknown as Record<string, unknown>[];
    broken[2].shortname = 98765;
    answerWith(broken);
    const err = await caught(getCourses(httpConn, 4242));
    expect(err).toBeInstanceOf(UnexpectedAnswer);
    const e = err as UnexpectedAnswer;
    expect(e.fn).toBe("core_enrol_get_users_courses");
    expect(e.path).toBe("[2].shortname");
    expect(e.message).toContain("core_enrol_get_users_courses");
    expect(e.message).toContain("[2].shortname");
    for (const value of ["98765", "3103", "Supply Chain Analytics", "ISM-E1005", "Forecasting"]) {
      expect(e.message).not.toContain(value);
    }
  });
});

describe("extractCode", () => {
  it.each([
    ["ISM-E1005 - Forecasting Methods", "ISM-E1005"],
    ["CS-A1110 Programming 1", "CS-A1110"],
    ["TU-E2210 Project", "TU-E2210"],
    ["ELEC-C7420 Basics", "ELEC-C7420"],
    ["MS-A0001 Matrix Algebra", "MS-A0001"],
    ["37E00200 - Strategic IT Management", "37E00200"],
    ["31E00100 Microeconomics", "31E00100"],
    ["Lecture, CS-E4000 (autumn)", "CS-E4000"],
  ])("finds the code in %s", (text, code) => {
    expect(extractCode(text)).toBe(code);
  });

  it.each([
    "Orientation week",
    "Forecasting Methods, Lecture, 1.9.2026-18.12.2026",
    "cs-a1110 lowercase",
    "XCS-A1110Z glued",
    "2026",
  ])("finds no code in %s", (text) => {
    expect(extractCode(text)).toBeNull();
  });
});

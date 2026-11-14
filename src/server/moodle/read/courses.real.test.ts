// @vitest-environment node
// getCourses against MyCourses' real answer (shape-only copy, tests/fixtures/moodle/).
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeMoodle, type FakeMoodle } from "../../../../tests/fake-moodle/server";
import type { MoodleConn } from "../client";
import { getCourses, nameWithoutCode } from "./courses";

const REAL = fileURLToPath(new URL("../../../../tests/fixtures/moodle/", import.meta.url));

let moodle: FakeMoodle;
let conn: MoodleConn;

beforeEach(async () => {
  moodle = await startFakeMoodle({ dir: REAL });
  conn = { siteUrl: moodle.url, token: moodle.token };
});
afterEach(async () => {
  await moodle.close();
});

describe("getCourses on the real MyCourses answer", () => {
  it("reads her 6 courses with their codes", async () => {
    const courses = await getCourses(conn, 900005);
    expect(courses.map((c) => [c.moodleId, c.code])).toEqual([
      [50865, "ISM-E1005"],
      [52232, "37E00200"],
      [51297, "ISM-E3003"],
      [49911, "ISM-E2004"],
      [51760, "FAKE-E9001"],
      [51761, "FAKE-E9002"],
    ]);
  });

  it("takes the code from a '<code>_aalto-cur-P-<uuid>' short name and keeps the short name", async () => {
    const [first] = await getCourses(conn, 900005);
    expect(first.shortName).toBe("ISM-E1005_aalto-cur-P-00000000-0000-4000-8000-000000000004");
    expect(first.code).toBe("ISM-E1005");
  });

  it("drops the leading '<code> - ' from the name, and keeps the rest", async () => {
    const courses = await getCourses(conn, 900005);
    expect(courses[0].name).toBe("Forecasting Methods, Contact teaching, 31.8.2026-12.10.2026");
    expect(courses[3].name).toBe("Digital Service Design, Blended teaching, 2.9.2026-7.10.2026");
    for (const c of courses) expect(c.name.startsWith(c.code ?? "?")).toBe(false);
  });
});

describe("nameWithoutCode", () => {
  it("leaves names that do not start with the code as they are", () => {
    expect(nameWithoutCode("Forecasting Methods, Lecture", "ISM-E1005")).toBe("Forecasting Methods, Lecture");
    expect(nameWithoutCode("ISM-E1005 - Forecasting", null)).toBe("ISM-E1005 - Forecasting");
    // A longer code that only starts the same way is not this code.
    expect(nameWithoutCode("ISM-E10050 Something", "ISM-E1005")).toBe("ISM-E10050 Something");
    // Nothing after the separator: keep the full name rather than an empty one.
    expect(nameWithoutCode("ISM-E1005 - ", "ISM-E1005")).toBe("ISM-E1005 - ");
  });

  it("accepts a dash, an en dash or a colon as the separator", () => {
    expect(nameWithoutCode("CS-A1110 – Programming 1", "CS-A1110")).toBe("Programming 1");
    expect(nameWithoutCode("CS-A1110: Programming 1", "CS-A1110")).toBe("Programming 1");
  });
});

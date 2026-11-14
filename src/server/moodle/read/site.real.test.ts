// @vitest-environment node
// getSiteInfo against MyCourses' real answer (shape-only copy, tests/fixtures/moodle/).
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeMoodle, type FakeMoodle } from "../../../../tests/fake-moodle/server";
import type { MoodleConn } from "../client";
import { getSiteInfo } from "./site";

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

describe("getSiteInfo on the real MyCourses answer", () => {
  it("reads who she is, the release and her upload limit", async () => {
    const info = await getSiteInfo(conn);
    expect(info.userId).toBe(900005);
    expect(info.siteName).toBe("MyCourses");
    expect(info.release).toBe("5.1.4 (Build: 20260420)");
    expect(info.canUpload).toBe(true);
    expect(info.maxUploadBytes).toBe(419_430_400);
  });

  it("lists all 448 functions, the hand-in ones among them", async () => {
    const info = await getSiteInfo(conn);
    expect(info.functions).toHaveLength(448);
    expect(info.functions).toEqual(
      expect.arrayContaining([
        "core_enrol_get_users_courses",
        "mod_assign_get_assignments",
        "mod_assign_get_submission_status",
        "mod_assign_save_submission",
        "mod_assign_submit_for_grading",
      ]),
    );
    expect(info.functions).not.toContain("core_files_upload");
  });
});

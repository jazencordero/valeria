// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import sample from "../../../../tests/fixtures/moodle-sample/core_webservice_get_site_info.json";
import { MoodleError, type MoodleConn } from "../client";
import { DEMO_KEY } from "../fake-inline";
import { UnexpectedAnswer, getSiteInfo, parseAnswer } from "./site";

const fakeConn: MoodleConn = { siteUrl: "https://moodle.example.edu", token: DEMO_KEY };
const httpConn: MoodleConn = { siteUrl: "https://moodle.example.edu", token: "test-token" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Make Moodle answer `body` over (stubbed) HTTP. */
function answerWith(body: unknown) {
  vi.stubEnv("MOODLE_FAKE", "0");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("getSiteInfo", () => {
  it("reads the sample answer from the fake Moodle", async () => {
    vi.stubEnv("MOODLE_FAKE", "1");
    const info = await getSiteInfo(fakeConn);
    expect(info).toEqual({
      userId: 4242,
      fullName: "Test Student",
      siteName: "Demo University",
      release: "4.5.1 (Build: 20241209)",
      functions: [
        "core_webservice_get_site_info",
        "core_enrol_get_users_courses",
        "core_course_get_contents",
        "mod_assign_get_assignments",
        "mod_assign_get_submission_status",
        "mod_assign_save_submission",
        "mod_assign_submit_for_grading",
      ],
      canUpload: true,
      maxUploadBytes: 52428800,
    });
    // Unknown fields are dropped.
    expect(Object.keys(info)).not.toContain("username");
  });

  it("treats -1 and 0 upload limits as no known cap, and missing optional fields as off", async () => {
    answerWith({ ...sample, usermaxuploadfilesize: -1 });
    expect((await getSiteInfo(httpConn)).maxUploadBytes).toBeNull();

    answerWith({ ...sample, usermaxuploadfilesize: 0 });
    expect((await getSiteInfo(httpConn)).maxUploadBytes).toBeNull();

    const { uploadfiles, usermaxuploadfilesize, release, ...bare } = sample;
    void uploadfiles;
    void usermaxuploadfilesize;
    void release;
    answerWith(bare);
    const info = await getSiteInfo(httpConn);
    expect(info.canUpload).toBe(false);
    expect(info.maxUploadBytes).toBeNull();
    expect(info.release).toBeNull();

    answerWith({ ...sample, uploadfiles: 0 });
    expect((await getSiteInfo(httpConn)).canUpload).toBe(false);
  });

  it("throws UnexpectedAnswer with the path, not the data, on a broken answer", async () => {
    const secretName = "Broken Person Name";
    answerWith({
      ...sample,
      fullname: secretName,
      sitename: "Secret Site Name",
      functions: [{ name: "core_webservice_get_site_info" }, { name: 12345 }],
    });
    const err = await caught(getSiteInfo(httpConn));
    expect(err).toBeInstanceOf(UnexpectedAnswer);
    expect(err).toBeInstanceOf(MoodleError);
    const e = err as UnexpectedAnswer;
    expect(e.name).toBe("UnexpectedAnswer");
    expect(e.fn).toBe("core_webservice_get_site_info");
    expect(e.path).toBe("functions[1].name");
    expect(e.message).toContain("core_webservice_get_site_info");
    expect(e.message).toContain("functions[1].name");
    for (const value of [secretName, "Secret Site Name", "12345", "4242", "test.student"]) {
      expect(e.message).not.toContain(value);
    }
  });

  it("names the missing field when one is absent", async () => {
    const { userid, ...noUser } = sample;
    void userid;
    answerWith(noUser);
    const e = (await caught(getSiteInfo(httpConn))) as UnexpectedAnswer;
    expect(e).toBeInstanceOf(UnexpectedAnswer);
    expect(e.path).toBe("userid");
  });
});

describe("parseAnswer", () => {
  it("returns parsed data and strips unknown fields", () => {
    const schema = z.object({ a: z.number() });
    expect(parseAnswer("fn_x", schema, { a: 1, b: "drop me" })).toEqual({ a: 1 });
  });

  it("reports a root mismatch as (root)", () => {
    const schema = z.array(z.object({ a: z.number() }));
    try {
      parseAnswer("fn_x", schema, { not: "an array" });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnexpectedAnswer);
      expect((err as UnexpectedAnswer).path).toBe("(root)");
      expect((err as UnexpectedAnswer).message).not.toContain("an array");
    }
  });
});

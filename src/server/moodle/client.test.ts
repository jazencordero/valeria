// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeMoodle, FAKE_UPLOAD_ITEMID, type FakeMoodle } from "../../../tests/fake-moodle/server";
import {
  KeyRejected,
  MoodleDown,
  MoodleError,
  NotAllowed,
  callMoodle,
  fileUrl,
  flattenParams,
  uploadFile,
  type MoodleConn,
} from "./client";
import { DEMO_KEY, FAKE_DRAFT_ITEMID } from "./fake-inline";

let moodle: FakeMoodle;
let conn: MoodleConn;

beforeAll(async () => {
  moodle = await startFakeMoodle();
  conn = { siteUrl: moodle.url + "/", token: moodle.token };
});
afterAll(async () => {
  await moodle.close();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function lastCall() {
  return moodle.calls[moodle.calls.length - 1];
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("flattenParams", () => {
  it("flattens nested arrays and objects Moodle-style", () => {
    expect(
      flattenParams({
        courseids: [3, 4],
        options: [{ name: "includestealth", value: true }],
        plugindata: { files_filemanager: 777001, onlinetext_editor: { text: "hi", format: 1 } },
        skip: null,
        off: false,
      }),
    ).toEqual([
      ["courseids[0]", "3"],
      ["courseids[1]", "4"],
      ["options[0][name]", "includestealth"],
      ["options[0][value]", "1"],
      ["plugindata[files_filemanager]", "777001"],
      ["plugindata[onlinetext_editor][text]", "hi"],
      ["plugindata[onlinetext_editor][format]", "1"],
      ["off", "0"],
    ]);
  });

  it("sends flattened params, the function and the token in the POST body", async () => {
    await callMoodle(conn, "mod_assign_get_assignments", { courseids: [3101, 3103], capabilities: ["mod/assign:submit"] });
    expect(lastCall()).toEqual({
      path: "/webservice/rest/server.php",
      fn: "mod_assign_get_assignments",
      params: { "courseids[0]": "3101", "courseids[1]": "3103", "capabilities[0]": "mod/assign:submit" },
      token: moodle.token,
    });
  });
});

describe("callMoodle", () => {
  it("returns the sample answers", async () => {
    const info = await callMoodle<{ fullname: string; userid: number }>(conn, "core_webservice_get_site_info");
    expect(info.fullname).toBe("Test Student");
    const courses = await callMoodle<{ shortname: string }[]>(conn, "core_enrol_get_users_courses", { userid: info.userid });
    expect(courses).toHaveLength(4);
    expect(courses.map((c) => c.shortname).join(" ")).toContain("ISM-E1005");
  });

  it("samples have 3 open assignments with intro attachments, one needing a Submit press", async () => {
    type A = { duedate: number; submissiondrafts: number; requiresubmissionstatement: number; introattachments: { fileurl: string }[] };
    const res = await callMoodle<{ courses: { assignments: A[] }[] }>(conn, "mod_assign_get_assignments");
    const all = res.courses.flatMap((c) => c.assignments);
    expect(all).toHaveLength(3);
    expect(all.every((a) => a.introattachments.length > 0 && a.introattachments[0].fileurl.includes("/webservice/pluginfile.php/"))).toBe(true);
    expect(all.filter((a) => a.submissiondrafts === 1)).toHaveLength(1);
    expect(all.find((a) => a.submissiondrafts === 1)?.requiresubmissionstatement).toBe(1);
  });

  it("maps invalidtoken to KeyRejected", async () => {
    const err = await caught(callMoodle({ ...conn, token: "wrong" }, "core_webservice_get_site_info"));
    expect(err).toBeInstanceOf(KeyRejected);
    expect((err as KeyRejected).errorcode).toBe("invalidtoken");
  });

  it("maps a token the server was told to reject to KeyRejected", async () => {
    const other = await startFakeMoodle();
    try {
      other.rejectToken();
      const err = await caught(callMoodle({ siteUrl: other.url, token: other.token }, "core_webservice_get_site_info"));
      expect(err).toBeInstanceOf(KeyRejected);
    } finally {
      await other.close();
    }
  });

  it("maps accessexception to KeyRejected", async () => {
    moodle.override("core_calendar_get_action_events_by_timesort", {
      body: { exception: "webservice_access_exception", errorcode: "accessexception", message: "Access control exception" },
    });
    const err = await caught(callMoodle(conn, "core_calendar_get_action_events_by_timesort"));
    expect(err).toBeInstanceOf(KeyRejected);
    expect((err as KeyRejected).errorcode).toBe("accessexception");
  });

  it("maps a function missing from the service (debug answer) to NotAllowed", async () => {
    moodle.override("core_message_get_messages", {
      body: {
        exception: "webservice_access_exception",
        errorcode: "accessexception",
        message: "Access control exception",
        debuginfo: "Access to the function core_message_get_messages() is not allowed.",
      },
    });
    const err = await caught(callMoodle(conn, "core_message_get_messages"));
    expect(err).toBeInstanceOf(NotAllowed);
    expect((err as NotAllowed).fn).toBe("core_message_get_messages");
  });

  it("maps a function Moodle does not have to NotAllowed(fn)", async () => {
    const err = await caught(callMoodle(conn, "local_nothing_here"));
    expect(err).toBeInstanceOf(NotAllowed);
    expect((err as NotAllowed).fn).toBe("local_nothing_here");
    expect((err as NotAllowed).errorcode).toBe("invalidrecord");
  });

  it("maps other Moodle exceptions to a plain MoodleError", async () => {
    moodle.override("mod_assign_get_submission_status", {
      body: { exception: "require_login_exception", errorcode: "requireloginerror", message: "Course or activity not accessible." },
    });
    const err = await caught(callMoodle(conn, "mod_assign_get_submission_status", { assignid: 1 }));
    expect(err).toBeInstanceOf(MoodleError);
    expect(err).not.toBeInstanceOf(KeyRejected);
    expect(err).not.toBeInstanceOf(NotAllowed);
    expect(err).not.toBeInstanceOf(MoodleDown);
    expect((err as MoodleError).message).toBe("Course or activity not accessible.");
  });

  it("maps a 5xx to MoodleDown", async () => {
    moodle.override("core_course_get_contents", { status: 503, body: { error: "maintenance" } });
    const err = await caught(callMoodle(conn, "core_course_get_contents", { courseid: 3101 }));
    expect(err).toBeInstanceOf(MoodleDown);
    expect((err as MoodleDown).status).toBe(503);
  });

  it("maps a network failure to MoodleDown", async () => {
    const gone = await startFakeMoodle();
    await gone.close();
    const err = await caught(callMoodle({ siteUrl: gone.url, token: gone.token }, "core_webservice_get_site_info"));
    expect(err).toBeInstanceOf(MoodleDown);
    expect((err as MoodleDown).errorcode).toBe("network");
  });

  it("times out as MoodleDown", async () => {
    moodle.override("core_enrol_get_course_enrolment_methods", { delayMs: 1000, body: [] });
    const started = Date.now();
    const err = await caught(callMoodle(conn, "core_enrol_get_course_enrolment_methods", {}, { timeoutMs: 50 }));
    expect(err).toBeInstanceOf(MoodleDown);
    expect((err as MoodleDown).errorcode).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("never logs the token or puts it in an error", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const secret = "secret-token-do-not-leak";
    const errs = [
      await caught(callMoodle({ ...conn, token: secret }, "core_webservice_get_site_info")),
      await caught(callMoodle({ siteUrl: "http://127.0.0.1:1", token: secret }, "core_webservice_get_site_info")),
    ];
    for (const e of errs) expect(JSON.stringify({ m: (e as Error).message, s: (e as Error).stack, ...(e as object) })).not.toContain(secret);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("uploadFile", () => {
  it("uploads to /webservice/upload.php and returns the draft itemid", async () => {
    const itemid = await uploadFile(conn, new TextEncoder().encode("%PDF-1.4 fake"), "memo.pdf");
    expect(itemid).toBe(FAKE_UPLOAD_ITEMID);
    expect(lastCall()).toMatchObject({
      path: "/webservice/upload.php",
      fn: "upload",
      params: { filearea: "draft", itemid: "0", file_1: "memo.pdf" },
      token: moodle.token,
    });
  });

  it("maps a rejected token on upload to KeyRejected", async () => {
    const err = await caught(uploadFile({ ...conn, token: "wrong" }, new Uint8Array([1]), "a.pdf"));
    expect(err).toBeInstanceOf(KeyRejected);
  });
});

describe("fileUrl", () => {
  const c = { siteUrl: "https://moodle.example.edu", token: "tok" };
  it("adds the token to files on her site", () => {
    expect(fileUrl(c, "https://moodle.example.edu/webservice/pluginfile.php/61301/mod_assign/introattachment/0/case.pdf")).toBe(
      "https://moodle.example.edu/webservice/pluginfile.php/61301/mod_assign/introattachment/0/case.pdf?token=tok",
    );
  });
  it("routes plain pluginfile links through the web service file server", () => {
    expect(fileUrl(c, "https://moodle.example.edu/pluginfile.php/1/a.pdf?forcedownload=1")).toBe(
      "https://moodle.example.edu/webservice/pluginfile.php/1/a.pdf?forcedownload=1&token=tok",
    );
  });
  it("never adds the token to another host", () => {
    expect(fileUrl(c, "https://elsewhere.example.com/x.pdf")).toBe("https://elsewhere.example.com/x.pdf");
  });
});

describe("MOODLE_FAKE=1", () => {
  const demo = { siteUrl: "https://moodle.example.edu", token: DEMO_KEY };

  it("answers in-process from the samples with the demo key", async () => {
    vi.stubEnv("MOODLE_FAKE", "1");
    const before = moodle.calls.length;
    const courses = await callMoodle<unknown[]>(demo, "core_enrol_get_users_courses", { userid: 4242 });
    expect(courses).toHaveLength(4);
    expect(await callMoodle(demo, "mod_assign_save_submission", { assignmentid: 7301 })).toEqual([]);
    expect(await uploadFile(demo, new Uint8Array([1]), "memo.pdf")).toBe(FAKE_DRAFT_ITEMID);
    expect(moodle.calls.length).toBe(before);
  });

  it("rejects any other key and unknown functions", async () => {
    vi.stubEnv("MOODLE_FAKE", "1");
    expect(await caught(callMoodle({ ...demo, token: "nope" }, "core_webservice_get_site_info"))).toBeInstanceOf(KeyRejected);
    expect(await caught(callMoodle(demo, "core_course_get_contents"))).toBeInstanceOf(NotAllowed);
  });

  it("refuses to run in production", async () => {
    vi.stubEnv("MOODLE_FAKE", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    const err = await caught(callMoodle(demo, "core_webservice_get_site_info"));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MoodleError);
    expect(await caught(uploadFile(demo, new Uint8Array([1]), "a.pdf"))).not.toBeInstanceOf(MoodleError);
  });
});

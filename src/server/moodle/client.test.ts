// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeMoodle, FAKE_UPLOAD_ITEMID, type FakeMoodle } from "../../../tests/fake-moodle/server";
import { users } from "../db/schema/users";
import { createTestDb } from "../db/test-db";
import {
  DAILY_LIMIT,
  KeyRejected,
  MIN_GAP_MS,
  MoodleDown,
  MoodleError,
  NotAllowed,
  USER_AGENT,
  callMoodle,
  configureMoodleClient,
  dbCallCountStore,
  fileUrl,
  flattenParams,
  moodleDay,
  resetMoodleClient,
  postMoodleForm,
  type CallCountStore,
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
beforeEach(() => {
  resetMoodleClient();
  // Tests never touch the app database unless they hand in their own store.
  configureMoodleClient({ countStore: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A fake clock: every wait is instant, moves the clock on, and is remembered. */
function instantSleep(start: number = Date.now()): number[] {
  const waits: number[] = [];
  let t = start;
  configureMoodleClient({
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
  });
  return waits;
}

/** A count store that starts each day at `start(day)` and records what is saved. */
function memoryStore(start: (day: string) => number) {
  const saved: { userId: string; day: string; count: number }[] = [];
  const store: CallCountStore = {
    load: async (_userId, day) => start(day),
    save: async (userId, day, count) => void saved.push({ userId, day, count }),
  };
  return { store, saved };
}

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

/** A one-file form post to the fake's file endpoint; answers with the draft itemid. */
async function postFile(c: MoodleConn, filename = "a.pdf"): Promise<number> {
  const form = new FormData();
  form.append("token", c.token);
  form.append("file_1", new Blob([new Uint8Array([1])]), filename);
  const answer = (await postMoodleForm(c, "/webservice/upload.php", form)) as { itemid: number }[];
  return answer[0].itemid;
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
    instantSleep();
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

describe("postMoodleForm", () => {
  it("posts the form to the path on her site and returns Moodle's answer", async () => {
    expect(await postFile(conn, "memo.pdf")).toBe(FAKE_UPLOAD_ITEMID);
    expect(lastCall()).toMatchObject({ params: { file_1: "memo.pdf" }, token: moodle.token });
  });

  it("maps a rejected token to KeyRejected", async () => {
    expect(await caught(postFile({ ...conn, token: "wrong" }))).toBeInstanceOf(KeyRejected);
  });

  it("only posts to a path on her site", async () => {
    const before = moodle.calls.length;
    expect(await caught(postMoodleForm(conn, "//elsewhere.example.com/x", new FormData()))).toBeInstanceOf(Error);
    expect(await caught(postMoodleForm(conn, "https://elsewhere.example.com/x", new FormData()))).toBeInstanceOf(Error);
    expect(moodle.calls.length).toBe(before);
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
    expect(await postFile(demo, "memo.pdf")).toBe(FAKE_DRAFT_ITEMID);
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
    expect(await caught(postFile(demo))).not.toBeInstanceOf(MoodleError);
  });
});

describe("politeness", () => {
  it("keeps ten parallel calls to two in flight, starting at least 150 ms apart", async () => {
    moodle.override("core_course_get_categories", { delayMs: 400, body: [] });
    const realFetch = globalThis.fetch;
    let inFlight = 0;
    let most = 0;
    const starts: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      starts.push(performance.now());
      most = Math.max(most, ++inFlight);
      try {
        return await realFetch(...args);
      } finally {
        inFlight--;
      }
    });
    const before = moodle.calls.length;
    const her = { ...conn, userId: "u-parallel" };
    const answers = await Promise.all(Array.from({ length: 10 }, () => callMoodle(her, "core_course_get_categories")));
    expect(answers).toEqual(Array(10).fill([]));
    expect(moodle.calls.length - before).toBe(10);
    expect(most).toBe(2);
    // The limiter spaces call starts 150 ms apart; measured at fetch() each gap can wobble by
    // event-loop lag on a busy machine, but the whole run can't be shorter than nine gaps.
    expect(starts.at(-1)! - starts[0]).toBeGreaterThanOrEqual(9 * MIN_GAP_MS - 25);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(MIN_GAP_MS / 2);
  });

  it("keeps each user to her own limits", async () => {
    moodle.override("core_course_get_categories", { delayMs: 200, body: [] });
    const started = performance.now();
    await Promise.all(["u-a", "u-b", "u-c"].map((userId) => callMoodle({ ...conn, userId }, "core_course_get_categories")));
    // Three users at once do not wait for each other's 150 ms gap or slots.
    expect(performance.now() - started).toBeLessThan(400);
  });

  it("retries a 429 with Retry-After: 1 after about a second", async () => {
    const realFetch = globalThis.fetch;
    const at: number[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      at.push(performance.now());
      if (at.length === 1) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
      return realFetch(...args);
    });
    const info = await callMoodle<{ fullname: string }>({ ...conn, userId: "u-429" }, "core_webservice_get_site_info");
    expect(info.fullname).toBe("Test Student");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(950);
    expect(at[1] - at[0]).toBeLessThan(1500);
  });

  it("waits 2, 4 and 8 seconds on a 503 without Retry-After, then is MoodleDown", async () => {
    const waits = instantSleep();
    moodle.override("core_course_get_courses", { status: 503, body: { error: "maintenance" } });
    const before = moodle.calls.length;
    const err = await caught(callMoodle({ ...conn, userId: "u-503" }, "core_course_get_courses"));
    expect(err).toBeInstanceOf(MoodleDown);
    expect((err as MoodleDown).status).toBe(503);
    expect(moodle.calls.length - before).toBe(4);
    expect(waits.filter((w) => w > MIN_GAP_MS)).toEqual([2000, 4000, 8000]);
  });

  it("is MoodleDown after three retried 429s, and at once for a Retry-After over a minute", async () => {
    const waits = instantSleep();
    moodle.override("core_course_get_courses", { status: 429, body: {} });
    const err = await caught(callMoodle({ ...conn, userId: "u-429-max" }, "core_course_get_courses"));
    expect(err).toBeInstanceOf(MoodleDown);
    expect((err as MoodleDown).status).toBe(429);
    expect(waits.filter((w) => w > MIN_GAP_MS)).toEqual([2000, 4000, 8000]);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 429, headers: { "retry-after": "3600" } }));
    waits.length = 0;
    expect(await caught(callMoodle({ ...conn, userId: "u-429-long" }, "core_course_get_courses"))).toBeInstanceOf(MoodleDown);
    expect(waits.filter((w) => w > MIN_GAP_MS)).toEqual([]);
  });

  it("retries form posts too", async () => {
    instantSleep();
    const realFetch = globalThis.fetch;
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) =>
      ++n === 1 ? new Response("{}", { status: 503 }) : realFetch(...args),
    );
    expect(await postFile({ ...conn, userId: "u-up" })).toBe(FAKE_UPLOAD_ITEMID);
    expect(n).toBe(2);
  });

  it("sends User-Agent: Ready/0.1 (student study tool) on calls and form posts", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await callMoodle(conn, "core_webservice_get_site_info");
    await postFile(conn);
    expect(USER_AGENT).toBe("Ready/0.1 (student study tool)");
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [, init] of spy.mock.calls) expect(new Headers(init?.headers).get("user-agent")).toBe(USER_AGENT);
  });

  it("refuses the 2,001st call of a day without a request", async () => {
    const { store, saved } = memoryStore(() => DAILY_LIMIT - 1);
    configureMoodleClient({ countStore: store });
    const her = { ...conn, userId: "u-limit" };
    await callMoodle(her, "core_webservice_get_site_info"); // the 2,000th
    expect(saved.at(-1)).toMatchObject({ userId: "u-limit", count: DAILY_LIMIT });

    const spy = vi.spyOn(globalThis, "fetch");
    const before = moodle.calls.length;
    const err = await caught(callMoodle(her, "core_webservice_get_site_info"));
    expect(err).toBeInstanceOf(MoodleDown);
    expect((err as MoodleDown).message).toBe("daily limit");
    expect(await caught(postFile(her))).toBeInstanceOf(MoodleDown);
    expect(spy).not.toHaveBeenCalled();
    expect(moodle.calls.length).toBe(before);
  });

  it("counts 2,000 calls in memory, then refuses", async () => {
    // A fixed midday start: 2,000 calls 150 ms apart take five minutes on the fake
    // clock, which crossed Helsinki midnight (and reset the count) when run after 23:55.
    instantSleep(Date.UTC(2026, 10, 14, 10, 0));
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json([]));
    const her = { ...conn, userId: "u-memory" };
    for (let i = 0; i < DAILY_LIMIT; i++) await callMoodle(her, "core_course_get_categories");
    expect(spy).toHaveBeenCalledTimes(DAILY_LIMIT);
    const err = await caught(callMoodle(her, "core_course_get_categories"));
    expect((err as MoodleDown).message).toBe("daily limit");
    expect(spy).toHaveBeenCalledTimes(DAILY_LIMIT);
    // Another user, and a call with no user, are not affected.
    await callMoodle({ ...conn, userId: "u-other" }, "core_course_get_categories");
    await callMoodle(conn, "core_course_get_categories");
  });

  it("starts a new count at midnight in Helsinki", async () => {
    // 21:59 and 22:01 UTC on 14 Nov 2026 are 23:59 and 00:01 in Helsinki.
    const late = Date.UTC(2026, 10, 14, 21, 59);
    const early = Date.UTC(2026, 10, 14, 22, 1);
    expect(moodleDay(late)).toBe("2026-11-14");
    expect(moodleDay(early)).toBe("2026-11-15");
    const { store } = memoryStore((day) => (day === "2026-11-14" ? DAILY_LIMIT : 0));
    configureMoodleClient({ countStore: store, now: () => late });
    const her = { ...conn, userId: "u-midnight" };
    expect(await caught(callMoodle(her, "core_webservice_get_site_info"))).toBeInstanceOf(MoodleDown);
    configureMoodleClient({ now: () => early });
    await expect(callMoodle(her, "core_webservice_get_site_info")).resolves.toMatchObject({ fullname: "Test Student" });
  });

  it("keeps calling when the count store fails", async () => {
    configureMoodleClient({
      countStore: { load: () => Promise.reject(new Error("db down")), save: () => Promise.reject(new Error("db down")) },
    });
    await expect(callMoodle({ ...conn, userId: "u-dbdown" }, "core_webservice_get_site_info")).resolves.toBeTruthy();
  });

  it("does not throttle or count the in-process fake", async () => {
    vi.stubEnv("MOODLE_FAKE", "1");
    const { store } = memoryStore(() => DAILY_LIMIT);
    configureMoodleClient({ countStore: store });
    const demo = { siteUrl: "https://moodle.example.edu", token: DEMO_KEY, userId: "u-fake" };
    await expect(callMoodle(demo, "core_webservice_get_site_info")).resolves.toBeTruthy();
  });
});

describe("dbCallCountStore", () => {
  it("keeps the day's count in users.settings.moodleCalls and refuses from it", async () => {
    const t = await createTestDb();
    try {
      // A fixed noon, so the test can't straddle Helsinki midnight.
      const noon = Date.UTC(2026, 10, 14, 10, 0);
      const today = moodleDay(noon);
      const [full] = await t.db
        .insert(users)
        .values({ settings: { theme: "calm", moodleCalls: { day: today, count: DAILY_LIMIT } } })
        .returning();
      const [fresh] = await t.db.insert(users).values({ settings: { moodleCalls: { day: "2000-01-01", count: 1999 } } }).returning();
      configureMoodleClient({ countStore: dbCallCountStore(t.db), now: () => noon });

      const before = moodle.calls.length;
      const err = await caught(callMoodle({ ...conn, userId: full.id }, "core_webservice_get_site_info"));
      expect((err as MoodleDown).message).toBe("daily limit");
      expect(moodle.calls.length).toBe(before);

      await callMoodle({ ...conn, userId: fresh.id }, "core_webservice_get_site_info");
      const settingsOf = async (id: string) =>
        (await t.db.select({ s: users.settings }).from(users).where(eq(users.id, id)))[0].s;
      expect(await settingsOf(fresh.id)).toEqual({ moodleCalls: { day: today, count: 1 } });

      // A late, lower save never lowers the count; other settings stay.
      const store = dbCallCountStore(t.db);
      await store.save(full.id, today, 5);
      expect(await settingsOf(full.id)).toEqual({ theme: "calm", moodleCalls: { day: today, count: DAILY_LIMIT } });
      expect(await store.load(full.id, today)).toBe(DAILY_LIMIT);
      expect(await store.load(full.id, "2000-01-02")).toBe(0);
    } finally {
      await t.close();
    }
  });
});

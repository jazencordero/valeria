// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_UPLOAD_ITEMID, startFakeMoodle, type FakeMoodle } from "../../../tests/fake-moodle/server";
import { confirmCodes, users } from "../db/schema/users";
import { createTestDb } from "../db/test-db";
import { KeyRejected, MoodleError, configureMoodleClient, resetMoodleClient, type MoodleConn } from "./client";
import { DEMO_KEY, FAKE_DRAFT_ITEMID } from "./fake-inline";
import {
  HANDIN_PURPOSE,
  HerTapInvalid,
  dbConsumeConfirmCode,
  herTapFromConfirmCode,
  type ConfirmCodeCheck,
  type ConsumeConfirmCode,
  type HerTap,
} from "./her-tap";
import { saveSubmission, submitForGrading, uploadDraftFile } from "./write";

const HER = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const ASSIGN = 7301;
const PDF = { name: "memo.pdf", bytes: new TextEncoder().encode("%PDF-1.4 fake") };

let moodle: FakeMoodle;
let conn: MoodleConn;

beforeAll(async () => {
  moodle = await startFakeMoodle();
  conn = { siteUrl: moodle.url + "/", token: moodle.token, userId: HER };
});
afterAll(async () => {
  await moodle.close();
});
beforeEach(() => {
  resetMoodleClient();
  configureMoodleClient({ countStore: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A consumer that says "ok" once per code, and remembers what it was asked. */
function memoryCodes() {
  const asked: ConfirmCodeCheck[] = [];
  const used = new Set<string>();
  const consume: ConsumeConfirmCode = async (check) => {
    asked.push(check);
    if (used.has(check.code)) return "used";
    used.add(check.code);
    return "ok";
  };
  return { consume, asked };
}

let codeN = 0;
async function tapFor(userId = HER, assignId = ASSIGN): Promise<HerTap> {
  const result = await herTapFromConfirmCode(
    { userId, assignId, code: `code-${++codeN}`, payloadHash: "h" },
    memoryCodes().consume,
  );
  if (!result.ok) throw new Error(result.reason);
  return result.tap;
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("hand-in against the fake Moodle", () => {
  it("records one upload, one save and one submit, in order", async () => {
    const before = moodle.calls.length;
    const tap = await tapFor();
    const itemId = await uploadDraftFile(conn, tap, PDF);
    expect(itemId).toBe(FAKE_UPLOAD_ITEMID);
    await saveSubmission(conn, tap, ASSIGN, itemId);
    await submitForGrading(conn, tap, ASSIGN);

    const calls = moodle.calls.slice(before);
    expect(calls.map((c) => c.fn)).toEqual(["upload", "mod_assign_save_submission", "mod_assign_submit_for_grading"]);
    expect(calls[0]).toMatchObject({
      path: "/webservice/upload.php",
      params: { filearea: "draft", itemid: "0", file_1: "memo.pdf" },
      token: moodle.token,
    });
    expect(calls[1].params).toEqual({ assignmentid: "7301", "plugindata[files_filemanager]": String(FAKE_UPLOAD_ITEMID) });
    expect(calls[2].params).toEqual({ assignmentid: "7301", acceptsubmissionstatement: "1" });
  });

  it("maps a rejected token on upload to KeyRejected", async () => {
    const err = await caught(uploadDraftFile({ ...conn, token: "wrong" }, await tapFor(), PDF));
    expect(err).toBeInstanceOf(KeyRejected);
  });

  it("turns a Moodle warning into a MoodleError", async () => {
    moodle.override("mod_assign_save_submission", {
      body: [{ item: "7301", itemid: 7301, warningcode: "couldnotsavesubmission", message: "Could not save submission" }],
    });
    try {
      const err = await caught(saveSubmission(conn, await tapFor(), ASSIGN, FAKE_UPLOAD_ITEMID));
      expect(err).toBeInstanceOf(MoodleError);
      expect(err).toMatchObject({ errorcode: "couldnotsavesubmission", message: "Could not save submission" });
    } finally {
      moodle.override("mod_assign_save_submission", { body: [] });
    }
  });

  it("works in-process with MOODLE_FAKE=1", async () => {
    vi.stubEnv("MOODLE_FAKE", "1");
    const before = moodle.calls.length;
    const demo = { siteUrl: "https://moodle.example.edu", token: DEMO_KEY, userId: HER };
    const tap = await tapFor();
    const itemId = await uploadDraftFile(demo, tap, PDF);
    expect(itemId).toBe(FAKE_DRAFT_ITEMID);
    await saveSubmission(demo, tap, ASSIGN, itemId);
    await submitForGrading(demo, tap, ASSIGN);
    expect(moodle.calls.length).toBe(before);
  });
});

describe("HerTap", () => {
  it("refuses a forged tap without a request", async () => {
    const before = moodle.calls.length;
    const forged = Object.freeze({ userId: HER, assignId: ASSIGN }) as unknown as HerTap;
    expect(await caught(uploadDraftFile(conn, forged, PDF))).toBeInstanceOf(HerTapInvalid);
    expect(await caught(submitForGrading(conn, forged, ASSIGN))).toBeInstanceOf(HerTapInvalid);
    expect(moodle.calls.length).toBe(before);
  });

  it("cannot be made or skipped without the compiler noticing", () => {
    // These lines never run; `npm run typecheck` fails if any of them compiles.
    const never = () => {
      // @ts-expect-error a plain object is not a HerTap
      void submitForGrading(conn, { userId: HER, assignId: ASSIGN }, ASSIGN);
      // @ts-expect-error the tap cannot be left out
      void submitForGrading(conn, ASSIGN);
    };
    expect(typeof never).toBe("function");
  });

  it("is for one user and one assignment", async () => {
    const before = moodle.calls.length;
    const tap = await tapFor();
    expect(await caught(uploadDraftFile({ ...conn, userId: "someone-else" }, tap, PDF))).toBeInstanceOf(HerTapInvalid);
    expect(await caught(uploadDraftFile({ ...conn, userId: undefined }, tap, PDF))).toBeInstanceOf(HerTapInvalid);
    expect(await caught(saveSubmission(conn, tap, 9999, 1))).toBeInstanceOf(HerTapInvalid);
    expect(await caught(submitForGrading(conn, tap, 9999))).toBeInstanceOf(HerTapInvalid);
    expect(moodle.calls.length).toBe(before);
  });

  it("is spent by the submit, and closes uploads once saved", async () => {
    const tap = await tapFor();
    const itemId = await uploadDraftFile(conn, tap, PDF);
    await saveSubmission(conn, tap, ASSIGN, itemId);
    expect(await caught(uploadDraftFile(conn, tap, PDF))).toBeInstanceOf(HerTapInvalid);
    expect(await caught(saveSubmission(conn, tap, ASSIGN, itemId))).toBeInstanceOf(HerTapInvalid);
    await submitForGrading(conn, tap, ASSIGN);
    const before = moodle.calls.length;
    expect(await caught(submitForGrading(conn, tap, ASSIGN))).toBeInstanceOf(HerTapInvalid);
    expect(moodle.calls.length).toBe(before);
  });

  it("asks the consumer for exactly her code, and makes no tap when it refuses", async () => {
    const { consume, asked } = memoryCodes();
    const req = { userId: HER, assignId: ASSIGN, code: "c-1", payloadHash: "abc" };
    expect((await herTapFromConfirmCode(req, consume)).ok).toBe(true);
    expect(asked[0]).toMatchObject({ code: "c-1", userId: HER, purpose: HANDIN_PURPOSE, payloadHash: "abc" });
    expect(await herTapFromConfirmCode(req, consume)).toEqual({ ok: false, reason: "used" });
    expect(await herTapFromConfirmCode({ ...req, code: "" }, consume)).toEqual({ ok: false, reason: "not_found" });
    expect(await herTapFromConfirmCode({ ...req, assignId: 0 }, consume)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("dbConsumeConfirmCode", () => {
  it("uses a code once, and says why it refuses", async () => {
    const t = await createTestDb();
    try {
      const [her] = await t.db.insert(users).values({}).returning();
      const [other] = await t.db.insert(users).values({}).returning();
      const now = new Date("2026-11-14T12:00:00Z");
      const later = new Date("2026-11-14T12:10:00Z");
      const [code, old] = await t.db
        .insert(confirmCodes)
        .values([
          { userId: her.id, purpose: HANDIN_PURPOSE, payloadHash: "h1", expiresAt: later },
          { userId: her.id, purpose: HANDIN_PURPOSE, payloadHash: "h2", expiresAt: now },
        ])
        .returning();
      const consume = dbConsumeConfirmCode(t.db);
      const check = { code: code.id, userId: her.id, purpose: HANDIN_PURPOSE, payloadHash: "h1", now };

      expect(await consume({ ...check, payloadHash: "other" })).toBe("changed");
      expect(await consume({ ...check, userId: other.id })).toBe("not_found");
      expect(await consume({ ...check, code: "not-a-uuid" })).toBe("not_found");
      expect(await consume({ ...check, code: old.id, payloadHash: "h2" })).toBe("expired");

      const [a, b] = await Promise.all([consume(check), consume(check)]);
      expect([a, b].sort()).toEqual(["ok", "used"]);
      const [row] = await t.db.select().from(confirmCodes).where(eq(confirmCodes.id, code.id));
      expect(row.usedAt).toEqual(now);
      expect(await consume(check)).toBe("used");

      const made = await herTapFromConfirmCode(
        { userId: her.id, assignId: ASSIGN, code: code.id, payloadHash: "h1" },
        consume,
        now,
      );
      expect(made).toEqual({ ok: false, reason: "used" });
    } finally {
      await t.close();
    }
  });
});

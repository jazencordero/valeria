// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHOOLS } from "@/lib/schools";
import { ensureSessionFor, newToken } from "@/server/auth/session";
import { unseal } from "@/server/crypto/seal";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { moodleConnections } from "@/server/db/schema/moodle";
import { resetThrottle } from "@/server/throttle";
import { FAKE_QR_USERID, QR_LOGIN_FN, startFakeMoodle, type FakeMoodle } from "../../../tests/fake-moodle/server";
import { MoodleError } from "./client";
import { TOO_MANY_TRIES } from "./connect";
import { DEMO_KEY } from "./fake-inline";
import { QR_TRIES_PER_MINUTE, QR_USER_AGENT, connectWithQr, parseQr } from "./qr";

// Made-up values for tests only. connectWithKey runs under MOODLE_FAKE=1, whose
// in-process fake accepts DEMO_KEY, so the fake server swaps QR keys for DEMO_KEY.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const AALTO = SCHOOLS.aalto.siteUrl;
const EXPIRED = "That code ran out. Show it again in MyCourses.";

let moodle: FakeMoodle;
let t: TestDb;

beforeAll(async () => {
  moodle = await startFakeMoodle();
});
afterAll(async () => {
  await moodle.close();
});
beforeEach(async () => {
  vi.stubEnv("MOODLE_FAKE", "1");
  vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
  resetThrottle();
  moodle.calls.length = 0;
  t = await createTestDb();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await t.close();
});

async function anonymousUser() {
  const { user } = await ensureSessionFor(t.db, newToken());
  return user.id;
}

const qrText = (key: string, userid = FAKE_QR_USERID, site: string = AALTO) =>
  `moodlemobile://${site}?qrlogin=${key}&userid=${userid}`;
const viaFake = () => ({ exchangeSite: moodle.url });
const qrCalls = () => moodle.calls.filter((c) => c.fn === QR_LOGIN_FN);

describe("parseQr", () => {
  it("reads the site, key and user id", () => {
    expect(parseQr(`moodlemobile://${AALTO}/?qrlogin=abc_123-X&userid=42`)).toEqual({
      site: AALTO,
      key: "abc_123-X",
      userid: 42,
    });
  });

  it("is null for text that is not a Moodle QR", () => {
    for (const text of ["", "hello", "moodlemobile://", `${AALTO}?userid=4`, `${AALTO}?qrlogin=abc`, `${AALTO}?qrlogin=a b&userid=4`, `${AALTO}?qrlogin=abc&userid=-1`, "javascript:alert(1)?qrlogin=a&userid=1"]) {
      expect(parseQr(text)).toBeNull();
    }
  });
});

describe("connectWithQr", () => {
  it("connects with a good code: a sealed connection row exists", async () => {
    const userId = await anonymousUser();
    const key = moodle.issueQrKey({ token: DEMO_KEY });
    expect(await connectWithQr(userId, qrText(key), t.db, viaFake())).toEqual({ ok: true, userId, merged: false });

    const rows = await t.db.select().from(moodleConnections);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, siteUrl: AALTO, status: "ok" });
    expect(rows[0].tokenSealed).not.toContain(DEMO_KEY);
    expect(unseal(rows[0].tokenSealed)).toBe(DEMO_KEY);
  });

  it("sends the exchange as the Moodle app, with the QR's key and user id", async () => {
    const userId = await anonymousUser();
    const key = moodle.issueQrKey({ token: DEMO_KEY });
    await connectWithQr(userId, qrText(key), t.db, viaFake());
    expect(qrCalls()).toHaveLength(1);
    const [call] = qrCalls();
    expect(call.path).toBe("/lib/ajax/service-nologin.php");
    expect(call.userAgent).toBe(QR_USER_AGENT);
    expect(call.userAgent).toContain("MoodleMobile");
    expect(call.userAgent).toContain("Ready/0.1 (student study tool)");
    expect(call.params).toEqual({ qrloginkey: key, userid: String(FAKE_QR_USERID) });
  });

  it("answers expired for a reused code, and stores nothing new", async () => {
    const userId = await anonymousUser();
    const key = moodle.issueQrKey({ token: DEMO_KEY });
    expect((await connectWithQr(userId, qrText(key), t.db, viaFake())).ok).toBe(true);
    const before = await t.db.select().from(moodleConnections);

    expect(await connectWithQr(userId, qrText(key), t.db, viaFake())).toEqual({
      ok: false,
      status: "expired",
      message: EXPIRED,
    });
    expect(await t.db.select().from(moodleConnections)).toEqual(before);
  });

  it("answers expired for an out-of-time code, an unknown code and a code for another user id", async () => {
    const userId = await anonymousUser();
    const old = moodle.issueQrKey({ token: DEMO_KEY, ttlMs: 0 });
    const other = moodle.issueQrKey({ token: DEMO_KEY });
    for (const text of [qrText(old), qrText("neverissued"), qrText(other, FAKE_QR_USERID + 1)]) {
      expect(await connectWithQr(userId, text, t.db, viaFake())).toEqual({ ok: false, status: "expired", message: EXPIRED });
    }
    expect(await t.db.select().from(moodleConnections)).toHaveLength(0);
  });

  it("refuses a QR for another site without calling Moodle", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const userId = await anonymousUser();
    const key = moodle.issueQrKey({ token: DEMO_KEY });
    for (const site of ["https://moodle.example.edu", moodle.url, "http://mycourses.aalto.fi"]) {
      expect(await connectWithQr(userId, qrText(key, FAKE_QR_USERID, site), t.db, viaFake())).toEqual({
        ok: false,
        status: "site_not_allowed",
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await t.db.select().from(moodleConnections)).toHaveLength(0);
  });

  it("refuses garbage without calling Moodle", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const userId = await anonymousUser();
    for (const text of ["", "not a code", "https://example.com/?a=b", "moodlemobile://nothing"]) {
      expect(await connectWithQr(userId, text, t.db, viaFake())).toEqual({ ok: false, status: "not_a_qr" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("brakes QR tries per visitor: over the minute limit Moodle is not called", async () => {
    const userId = await anonymousUser();
    for (let i = 0; i < QR_TRIES_PER_MINUTE; i++) {
      expect((await connectWithQr(userId, qrText(`spent${i}`), t.db, viaFake())).ok).toBe(false);
    }
    const sent = qrCalls().length;
    expect(sent).toBe(QR_TRIES_PER_MINUTE);
    expect(await connectWithQr(userId, qrText(moodle.issueQrKey({ token: DEMO_KEY })), t.db, viaFake())).toEqual({
      ok: false,
      reason: "too_many",
      message: TOO_MANY_TRIES,
    });
    expect(qrCalls()).toHaveLength(sent);
  });

  it("throws, and does not say expired, when Moodle refuses us as not the app", async () => {
    const strict = await startFakeMoodle();
    strict.override(QR_LOGIN_FN, {
      body: [{ error: true, exception: { errorcode: "apprequired", message: "This functionality is only available from the Moodle app." } }],
    });
    try {
      const userId = await anonymousUser();
      const err = await connectWithQr(userId, qrText(strict.issueQrKey()), t.db, { exchangeSite: strict.url }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MoodleError);
      expect((err as MoodleError).errorcode).toBe("apprequired");
    } finally {
      await strict.close();
    }
  });

  it("never puts the key or the token in a result or an error", async () => {
    const userId = await anonymousUser();
    const key = moodle.issueQrKey({ token: DEMO_KEY });
    const good = await connectWithQr(userId, qrText(key), t.db, viaFake());
    const reused = await connectWithQr(userId, qrText(key), t.db, viaFake());
    for (const r of [good, reused]) {
      expect(JSON.stringify(r)).not.toContain(key);
      expect(JSON.stringify(r)).not.toContain(DEMO_KEY);
    }
  });

  it("does not reach a real Moodle in fake mode without a fake to send the exchange to", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const userId = await anonymousUser();
    await expect(connectWithQr(userId, qrText("abc"), t.db)).rejects.toThrow(/exchangeSite/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

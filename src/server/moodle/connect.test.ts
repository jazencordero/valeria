// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHOOLS, allowedSiteUrls } from "@/lib/schools";
import { ensureSessionFor, newToken } from "@/server/auth/session";
import { unseal } from "@/server/crypto/seal";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { moodleConnections } from "@/server/db/schema/moodle";
import { identities, sessions, users } from "@/server/db/schema/users";
import { resetThrottle } from "@/server/throttle";
import { DEMO_KEY } from "./fake-inline";
import { getSiteInfo } from "./read/site";
import {
  ALLOWED_SITES,
  CONNECT_TRIES_PER_DAY,
  CONNECT_TRIES_PER_MINUTE,
  TOO_MANY_TRIES,
  allowedSite,
  can,
  connectWithKey,
  disconnect,
  getConnection,
} from "./connect";

// The real site check, wrapped so the tests can count the calls that reach Moodle.
vi.mock("./read/site", async (importOriginal) => {
  const real = await importOriginal<typeof import("./read/site")>();
  return { ...real, getSiteInfo: vi.fn(real.getSiteInfo) };
});
const moodleCalls = () => vi.mocked(getSiteInfo).mock.calls.length;

// Made-up values for tests only. The fake Moodle accepts DEMO_KEY and nothing else.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const BAD_KEY = "not-a-real-key-0000";
const AALTO = SCHOOLS.aalto.siteUrl;
// Made up: LUT has no site in schools.ts yet (M8-18), so any LUT address is refused.
const LUT_GUESS = "https://moodle.lut.fi";
// The sample site info answers with this Moodle user id.
const SAMPLE_MOODLE_USER_ID = 4242;

let t: TestDb;
beforeEach(async () => {
  vi.stubEnv("MOODLE_FAKE", "1");
  vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
  vi.mocked(getSiteInfo).mockClear();
  resetThrottle();
  t = await createTestDb();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await t.close();
});

async function anonymousUser() {
  const { user } = await ensureSessionFor(t.db, newToken());
  return user.id;
}

describe("ALLOWED_SITES", () => {
  it("comes from schools.ts: only schools that are enabled and have a site", () => {
    expect(ALLOWED_SITES).toEqual(allowedSiteUrls());
    expect(ALLOWED_SITES).toEqual([AALTO]);
    expect(SCHOOLS.lut.enabled).toBe(false);
  });
});

describe("allowedSite", () => {
  it("refuses LUT and unknown sites while LUT is not enabled", () => {
    expect(allowedSite(LUT_GUESS)).toBeNull();
    expect(allowedSite("https://moodle.example.edu")).toBeNull();
    expect(allowedSite("")).toBeNull();
  });

  it("accepts only MyCourses over https, ignoring a trailing slash", () => {
    expect(allowedSite("https://mycourses.aalto.fi")).toBe(AALTO);
    expect(allowedSite("https://mycourses.aalto.fi/")).toBe(AALTO);
    expect(allowedSite("http://mycourses.aalto.fi")).toBeNull();
    expect(allowedSite("https://mycourses.aalto.fi.example.com")).toBeNull();
    expect(allowedSite("https://moodle.example.edu")).toBeNull();
  });
});

describe("connectWithKey", () => {
  it("stores a good key sealed, not as the key, with her functions and identity", async () => {
    const userId = await anonymousUser();
    const result = await connectWithKey(userId, AALTO, DEMO_KEY, t.db);
    expect(result).toEqual({ ok: true, userId, merged: false });

    const rows = await t.db.select().from(moodleConnections);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.userId).toBe(userId);
    expect(row.siteUrl).toBe(AALTO);
    expect(row.moodleUserId).toBe(SAMPLE_MOODLE_USER_ID);
    expect(row.status).toBe("ok");
    expect(row.functions).toContain("mod_assign_get_assignments");
    expect(row.tokenSealed).not.toBe(DEMO_KEY);
    expect(row.tokenSealed).not.toContain(DEMO_KEY);
    expect(unseal(row.tokenSealed)).toBe(DEMO_KEY);

    expect(await t.db.select().from(identities)).toMatchObject([
      { userId, kind: "moodle", siteUrl: AALTO, externalId: String(SAMPLE_MOODLE_USER_ID) },
    ]);
  });

  it("stores the canonical site when she pastes it with a trailing slash", async () => {
    const userId = await anonymousUser();
    expect((await connectWithKey(userId, `${AALTO}/`, DEMO_KEY, t.db)).ok).toBe(true);
    const [row] = await t.db.select().from(moodleConnections);
    expect(row.siteUrl).toBe(AALTO);
  });

  it("stores nothing for a key Moodle rejects", async () => {
    const userId = await anonymousUser();
    expect(await connectWithKey(userId, AALTO, BAD_KEY, t.db)).toEqual({ ok: false, reason: "rejected" });
    expect(await t.db.select().from(moodleConnections)).toHaveLength(0);
    expect(await t.db.select().from(identities)).toHaveLength(0);
  });

  it("leaves an existing connection alone when a later key is rejected", async () => {
    const userId = await anonymousUser();
    await connectWithKey(userId, AALTO, DEMO_KEY, t.db);
    const before = await t.db.select().from(moodleConnections);
    expect((await connectWithKey(userId, AALTO, BAD_KEY, t.db)).ok).toBe(false);
    expect(await t.db.select().from(moodleConnections)).toEqual(before);
  });

  it("refuses a site that is not MyCourses without calling Moodle", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const userId = await anonymousUser();
      expect(await connectWithKey(userId, "https://moodle.example.edu", DEMO_KEY, t.db)).toEqual({
        ok: false,
        reason: "site_not_allowed",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await t.db.select().from(moodleConnections)).toHaveLength(0);
      expect(await t.db.select().from(identities)).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a LUT site without calling Moodle, since LUT cannot connect yet", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const userId = await anonymousUser();
      expect(await connectWithKey(userId, LUT_GUESS, DEMO_KEY, t.db)).toEqual({
        ok: false,
        reason: "site_not_allowed",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(moodleCalls()).toBe(0);
      expect(await t.db.select().from(moodleConnections)).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-connecting the same user replaces the key and keeps one row", async () => {
    const userId = await anonymousUser();
    await connectWithKey(userId, AALTO, DEMO_KEY, t.db);
    const [first] = await t.db.select().from(moodleConnections);
    expect(await connectWithKey(userId, AALTO, DEMO_KEY, t.db)).toEqual({ ok: true, userId, merged: false });
    const rows = await t.db.select().from(moodleConnections);
    expect(rows).toHaveLength(1);
    // A fresh nonce each seal, so the stored value changes.
    expect(rows[0].tokenSealed).not.toBe(first.tokenSealed);
    expect(await t.db.select().from(identities)).toHaveLength(1);
  });

  it("refuses a good key for a different Moodle user than this account already has", async () => {
    const userId = await anonymousUser();
    // As if she had connected before as another Moodle user on the same site.
    await t.db.insert(identities).values({ userId, kind: "moodle", siteUrl: AALTO, externalId: "777" });
    expect(await connectWithKey(userId, AALTO, DEMO_KEY, t.db)).toEqual({ ok: false, reason: "other_account" });
    expect(await t.db.select().from(moodleConnections)).toHaveLength(0);
    const ids = await t.db.select().from(identities);
    expect(ids.map((i) => i.externalId)).toEqual(["777"]);
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it("merges a second anonymous user with the same Moodle user: one user, both sessions", async () => {
    const phone = await anonymousUser();
    const laptop = await anonymousUser();
    expect(await t.db.select().from(users)).toHaveLength(2);

    await connectWithKey(phone, AALTO, DEMO_KEY, t.db);
    const result = await connectWithKey(laptop, AALTO, DEMO_KEY, t.db);
    expect(result).toEqual({ ok: true, userId: phone, merged: true });

    const allUsers = await t.db.select().from(users);
    expect(allUsers.map((u) => u.id)).toEqual([phone]);
    const allSessions = await t.db.select().from(sessions);
    expect(allSessions).toHaveLength(2);
    expect(allSessions.every((s) => s.userId === phone)).toBe(true);

    const connections = await t.db.select().from(moodleConnections);
    expect(connections).toHaveLength(1);
    expect(connections[0].userId).toBe(phone);
    expect(await t.db.select().from(identities)).toHaveLength(1);
  });
});

describe("connectWithKey, brake on key guessing", () => {
  const T0 = new Date("2026-11-14T10:00:00Z");
  const SEC = 1000;
  const at = (ms: number) => vi.setSystemTime(new Date(T0.getTime() + ms));
  const TOO_MANY = { ok: false, reason: "too_many", message: TOO_MANY_TRIES };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
  });

  it("refuses the sixth try within a minute without calling Moodle, even with a good key", async () => {
    expect(CONNECT_TRIES_PER_MINUTE).toBe(5);
    const userId = await anonymousUser();
    for (let i = 0; i < 5; i++) {
      expect(await connectWithKey(userId, AALTO, BAD_KEY, t.db)).toEqual({ ok: false, reason: "rejected" });
    }
    expect(moodleCalls()).toBe(5);

    at(59 * SEC);
    expect(await connectWithKey(userId, AALTO, DEMO_KEY, t.db)).toEqual(TOO_MANY);
    expect(moodleCalls()).toBe(5);
    expect(await t.db.select().from(moodleConnections)).toHaveLength(0);
    expect(await t.db.select().from(identities)).toHaveLength(0);
  });

  it("lets her try again once the minute is over", async () => {
    const userId = await anonymousUser();
    for (let i = 0; i < 5; i++) await connectWithKey(userId, AALTO, BAD_KEY, t.db);
    expect(await connectWithKey(userId, AALTO, DEMO_KEY, t.db)).toEqual(TOO_MANY);

    at(60 * SEC);
    expect(await connectWithKey(userId, AALTO, DEMO_KEY, t.db)).toEqual({ ok: true, userId, merged: false });
    expect(moodleCalls()).toBe(6);
  });

  it("counts a good key as a try", async () => {
    const userId = await anonymousUser();
    for (let i = 0; i < 5; i++) expect((await connectWithKey(userId, AALTO, DEMO_KEY, t.db)).ok).toBe(true);
    expect(await connectWithKey(userId, AALTO, DEMO_KEY, t.db)).toEqual(TOO_MANY);
  });

  it("does not count a site that is not allowed", async () => {
    const userId = await anonymousUser();
    for (let i = 0; i < 6; i++) {
      expect((await connectWithKey(userId, "https://moodle.example.edu", DEMO_KEY, t.db)).ok).toBe(false);
    }
    expect((await connectWithKey(userId, AALTO, DEMO_KEY, t.db)).ok).toBe(true);
  });

  it("allows 30 tries a day, then refuses until 24 hours after the first", async () => {
    expect(CONNECT_TRIES_PER_DAY).toBe(30);
    const userId = await anonymousUser();
    for (let i = 0; i < 30; i++) {
      at(Math.floor(i / 5) * 61 * SEC);
      expect(await connectWithKey(userId, AALTO, BAD_KEY, t.db), `try ${i + 1}`).toEqual({ ok: false, reason: "rejected" });
    }
    expect(moodleCalls()).toBe(30);

    at(7 * 61 * SEC);
    expect(await connectWithKey(userId, AALTO, DEMO_KEY, t.db)).toEqual(TOO_MANY);
    at(23 * 60 * 60 * SEC);
    expect(await connectWithKey(userId, AALTO, DEMO_KEY, t.db)).toEqual(TOO_MANY);
    expect(moodleCalls()).toBe(30);

    at(24 * 60 * 60 * SEC);
    expect(await connectWithKey(userId, AALTO, DEMO_KEY, t.db)).toEqual({ ok: true, userId, merged: false });
  });

  it("counts per visitor: another visitor is not slowed down", async () => {
    const one = await anonymousUser();
    const two = await anonymousUser();
    for (let i = 0; i < 5; i++) await connectWithKey(one, AALTO, BAD_KEY, t.db);
    expect(await connectWithKey(one, AALTO, DEMO_KEY, t.db)).toEqual(TOO_MANY);
    expect(await connectWithKey(two, AALTO, DEMO_KEY, t.db)).toEqual({ ok: true, userId: two, merged: false });
  });
});

describe("getConnection", () => {
  it("returns her site and the unsealed key, or null when not connected", async () => {
    const userId = await anonymousUser();
    expect(await getConnection(userId, t.db)).toBeNull();
    await connectWithKey(userId, AALTO, DEMO_KEY, t.db);
    expect(await getConnection(userId, t.db)).toEqual({ siteUrl: AALTO, token: DEMO_KEY, userId });
  });
});

describe("disconnect", () => {
  it("deletes only her connection row", async () => {
    const userId = await anonymousUser();
    await connectWithKey(userId, AALTO, DEMO_KEY, t.db);
    await disconnect(userId, t.db);
    expect(await t.db.select().from(moodleConnections).where(eq(moodleConnections.userId, userId))).toHaveLength(0);
    expect(await getConnection(userId, t.db)).toBeNull();
    expect(await can(userId, "mod_assign_get_assignments", t.db)).toBe(false);
  });
});

describe("can", () => {
  it("is true only for functions in her key's list", async () => {
    const userId = await anonymousUser();
    expect(await can(userId, "mod_assign_get_assignments", t.db)).toBe(false);
    await connectWithKey(userId, AALTO, DEMO_KEY, t.db);
    expect(await can(userId, "mod_assign_get_assignments", t.db)).toBe(true);
    expect(await can(userId, "mod_assign_submit_for_grading", t.db)).toBe(true);
    expect(await can(userId, "core_message_send_instant_messages", t.db)).toBe(false);
  });
});

// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { jobs } from "@/server/db/schema/system";
import { sessions, users } from "@/server/db/schema/users";
import {
  BAD_USERNAME,
  endDeviceSession,
  landingFor,
  logIn,
  LOGIN_WINDOW_MS,
  NO_MATCH,
  normalizeUsername,
  setLogin,
  signUp,
  TAKEN,
  TOO_MANY,
} from "./accounts";
import { verifyPassword } from "./password";
import { currentUserFor, hashToken } from "./session";

// Invented names and passwords only.
const NAME = "test.student";
const PASSWORD = "correct horse";
const WRONG = "battery staple";
const NOW = new Date("2026-11-15T10:00:00Z");
const T = 60_000;

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const at = (ms: number) => new Date(NOW.getTime() + ms);

describe("normalizeUsername", () => {
  it("lowers and trims, and keeps to 3-32 of a-z 0-9 . _ -", () => {
    expect(normalizeUsername("  Test.Student ")).toBe("test.student");
    expect(normalizeUsername("a_b-c.9")).toBe("a_b-c.9");
    expect(normalizeUsername("ab")).toBeNull();
    expect(normalizeUsername("x".repeat(33))).toBeNull();
    expect(normalizeUsername("two words")).toBeNull();
    expect(normalizeUsername("ä-name")).toBeNull();
  });
});

describe("signUp", () => {
  it("makes an account with a hashed password and a device session", { timeout: T }, async () => {
    const r = await signUp("Test.Student", PASSWORD, { db: t.db, now: NOW, settings: { agreedAt: NOW.toISOString() } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [user] = await t.db.select().from(users).where(eq(users.id, r.userId));
    expect(user.username).toBe(NAME);
    expect(user.passwordHash).toMatch(/^scrypt\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
    expect(user.settings).toEqual({ agreedAt: NOW.toISOString() });
    expect((await currentUserFor(t.db, r.token, NOW)).id).toBe(r.userId);
  });

  it("refuses a taken username, whatever its case, with one sentence", { timeout: T }, async () => {
    expect((await signUp(NAME, PASSWORD, { db: t.db })).ok).toBe(true);
    expect(await signUp("TEST.student", "another one", { db: t.db })).toEqual({ ok: false, error: TAKEN });
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it("refuses a malformed username and a password outside 5 to 200", async () => {
    expect(await signUp("no", PASSWORD, { db: t.db })).toEqual({ ok: false, error: BAD_USERNAME });
    expect(await signUp(NAME, "four", { db: t.db })).toEqual({ ok: false, error: "Use at least 5 characters." });
    expect(await t.db.select().from(users)).toHaveLength(0);
  });
});

describe("logIn", () => {
  beforeEach(async () => {
    const r = await signUp(NAME, PASSWORD, { db: t.db, now: NOW });
    expect(r.ok).toBe(true);
  });

  it("logs in with the right password, any case of the name, into a new device session", { timeout: T }, async () => {
    const r = await logIn(" Test.Student", PASSWORD, { db: t.db, now: NOW, userAgent: "test-agent" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [session] = await t.db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(r.token)));
    expect(session).toMatchObject({ userId: r.userId, userAgent: "test-agent" });
  });

  it("gives the same answer, after one hash check, for an unknown name and a wrong password", { timeout: T }, async () => {
    const verify = vi.fn(verifyPassword);
    const unknown = await logIn("nobody.here", PASSWORD, { db: t.db, now: NOW, verify });
    const wrong = await logIn(NAME, WRONG, { db: t.db, now: NOW, verify });
    const malformed = await logIn("x", PASSWORD, { db: t.db, now: NOW, verify });
    expect(unknown).toEqual({ ok: false, error: NO_MATCH });
    expect(wrong).toEqual({ ok: false, error: NO_MATCH });
    expect(malformed).toEqual({ ok: false, error: NO_MATCH });
    // Each try checked exactly one real scrypt hash (a dummy one when the name is unknown).
    expect(verify).toHaveBeenCalledTimes(3);
    for (const [, hash] of verify.mock.calls) expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    // Never a name, a password or an address in what is counted.
    const rows = JSON.stringify(await t.db.select().from(jobs));
    for (const secret of [NAME, PASSWORD, WRONG, "nobody.here"]) expect(rows).not.toContain(secret);
  });

  it("refuses the sixth wrong try in 15 minutes, even a right one, and lets a right one in after the wait", { timeout: T }, async () => {
    for (let i = 0; i < 5; i++) {
      expect(await logIn(NAME, WRONG, { db: t.db, now: at(i * 60_000) })).toEqual({ ok: false, error: NO_MATCH });
    }
    expect(await logIn(NAME, WRONG, { db: t.db, now: at(5 * 60_000) })).toEqual({ ok: false, error: TOO_MANY });
    expect(await logIn(NAME, PASSWORD, { db: t.db, now: at(6 * 60_000) })).toEqual({ ok: false, error: TOO_MANY });
    // A refused try is not counted; 15 minutes after the fails, the right password works.
    const later = await logIn(NAME, PASSWORD, { db: t.db, now: at(4 * 60_000 + LOGIN_WINDOW_MS + 1) });
    expect(later.ok).toBe(true);
  });

  it("brakes an unknown name exactly like a known one", { timeout: T }, async () => {
    for (let i = 0; i < 5; i++) expect((await logIn("nobody.here", WRONG, { db: t.db, now: NOW })).ok).toBe(false);
    expect(await logIn("nobody.here", WRONG, { db: t.db, now: NOW })).toEqual({ ok: false, error: TOO_MANY });
  });

  it("clears the name's count on a right password", { timeout: T }, async () => {
    for (let i = 0; i < 4; i++) await logIn(NAME, WRONG, { db: t.db, now: NOW });
    expect((await logIn(NAME, PASSWORD, { db: t.db, now: NOW })).ok).toBe(true);
    for (let i = 0; i < 5; i++) expect(await logIn(NAME, WRONG, { db: t.db, now: NOW })).toEqual({ ok: false, error: NO_MATCH });
    expect(await logIn(NAME, WRONG, { db: t.db, now: NOW })).toEqual({ ok: false, error: TOO_MANY });
  });

  it("refuses an address after 20 fails in 15 minutes, across names", { timeout: T }, async () => {
    const address = "203.0.113.7";
    for (let i = 0; i < 20; i++) {
      expect(await logIn(`guess.${i}`, WRONG, { db: t.db, now: NOW, address })).toEqual({ ok: false, error: NO_MATCH });
    }
    expect(await logIn(NAME, PASSWORD, { db: t.db, now: NOW, address })).toEqual({ ok: false, error: TOO_MANY });
    expect((await logIn(NAME, PASSWORD, { db: t.db, now: NOW, address: "198.51.100.2" })).ok).toBe(true);
    expect((await logIn(NAME, PASSWORD, { db: t.db, now: at(LOGIN_WINDOW_MS + 1), address })).ok).toBe(true);
  });
});

describe("endDeviceSession", () => {
  it("ends this device's session only", { timeout: T }, async () => {
    const a = await signUp(NAME, PASSWORD, { db: t.db });
    const b = await logIn(NAME, PASSWORD, { db: t.db });
    if (!a.ok || !b.ok) throw new Error("setup");
    await endDeviceSession(t.db, a.token);
    await expect(currentUserFor(t.db, a.token)).rejects.toThrow();
    expect((await currentUserFor(t.db, b.token)).id).toBe(a.userId);
    await endDeviceSession(t.db, "not a token");
  });
});

describe("landingFor", () => {
  it("sends a fresh account to the first run and anything further along to Home", { timeout: T }, async () => {
    const r = await signUp(NAME, PASSWORD, { db: t.db });
    if (!r.ok) throw new Error("setup");
    expect(await landingFor(t.db, r.userId)).toBe("/school");
    await t.db.update(users).set({ school: "aalto" }).where(eq(users.id, r.userId));
    // A school picked but no Moodle connection: Home, never /connect.
    expect(await landingFor(t.db, r.userId)).toBe("/home");
    const [seeded] = await t.db.insert(users).values({ settings: { seededFrom: { key: "k" } } }).returning();
    expect(await landingFor(t.db, seeded.id)).toBe("/home");
  });
});

describe("setLogin", () => {
  it("sets a name and a password on an existing user, and refuses a name someone else has", { timeout: T }, async () => {
    const [plain] = await t.db.insert(users).values({}).returning();
    expect(await setLogin(t.db, plain.id, { username: "Seeded.One", password: PASSWORD })).toEqual({ ok: true });
    expect((await logIn("seeded.one", PASSWORD, { db: t.db })).ok).toBe(true);
    expect(await setLogin(t.db, plain.id, { password: "a new one" })).toEqual({ ok: true });
    expect((await logIn("seeded.one", "a new one", { db: t.db })).ok).toBe(true);

    const [other] = await t.db.insert(users).values({}).returning();
    expect(await setLogin(t.db, other.id, { username: "seeded.one" })).toEqual({ ok: false, error: TAKEN });
    expect(await setLogin(t.db, other.id, { password: "four" })).toEqual({ ok: false, error: "Use at least 5 characters." });
  });
});

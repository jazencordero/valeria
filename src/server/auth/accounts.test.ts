// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { jobs } from "@/server/db/schema/system";
import { sessions, users } from "@/server/db/schema/users";
import {
  BAD_USERNAME,
  changePassword,
  DEMO_NO_LOGIN,
  endDeviceSession,
  HAS_LOGIN,
  landingFor,
  logIn,
  LOGIN_WINDOW_MS,
  NO_MATCH,
  normalizeUsername,
  setLogin,
  signUp,
  TAKEN,
  TOO_MANY,
  WRONG_CURRENT,
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

describe("setLogin, first only (M5-15)", () => {
  it("gives an account without a login a name and a hashed password", { timeout: T }, async () => {
    const [plain] = await t.db.insert(users).values({ settings: { seededFrom: { key: "k" } } }).returning();
    expect(await setLogin(t.db, plain.id, { username: " Own.Name ", password: PASSWORD }, { firstOnly: true })).toEqual({ ok: true });
    const [row] = await t.db.select().from(users).where(eq(users.id, plain.id));
    expect(row.username).toBe("own.name");
    expect(row.passwordHash).toMatch(/^scrypt\$/);
    expect(row.passwordHash).not.toContain(PASSWORD);
    expect(row.settings).toEqual({ seededFrom: { key: "k" } });
    const r = await logIn("own.name", PASSWORD, { db: t.db });
    expect(r.ok && r.userId).toBe(plain.id);
  });

  it("refuses a taken name with sign up's sentence, and the sign-up rules", { timeout: T }, async () => {
    expect((await signUp(NAME, PASSWORD, { db: t.db })).ok).toBe(true);
    const [plain] = await t.db.insert(users).values({}).returning();
    const first = { firstOnly: true };
    expect(await setLogin(t.db, plain.id, { username: "TEST.student", password: PASSWORD }, first)).toEqual({ ok: false, error: TAKEN });
    expect(await setLogin(t.db, plain.id, { username: "no", password: PASSWORD }, first)).toEqual({ ok: false, error: BAD_USERNAME });
    expect(await setLogin(t.db, plain.id, { username: "free.name", password: "four" }, first)).toEqual({
      ok: false,
      error: "Use at least 5 characters.",
    });
    const [row] = await t.db.select().from(users).where(eq(users.id, plain.id));
    expect(row).toMatchObject({ username: null, passwordHash: null });
  });

  it("never gives a second name or a password without the current one", { timeout: T }, async () => {
    const r = await signUp(NAME, PASSWORD, { db: t.db });
    if (!r.ok) throw new Error("setup");
    expect(await setLogin(t.db, r.userId, { username: "other.name", password: WRONG }, { firstOnly: true })).toEqual({
      ok: false,
      error: HAS_LOGIN,
    });
    const [row] = await t.db.select().from(users).where(eq(users.id, r.userId));
    expect(row.username).toBe(NAME);
    expect((await logIn(NAME, PASSWORD, { db: t.db })).ok).toBe(true);
    // A password without a name (as the seed tool can leave one) is a login too.
    const [half] = await t.db.insert(users).values({}).returning();
    await setLogin(t.db, half.id, { password: PASSWORD });
    expect(await setLogin(t.db, half.id, { username: "half.name", password: WRONG }, { firstOnly: true })).toEqual({
      ok: false,
      error: HAS_LOGIN,
    });
  });

  it("refuses a demo", { timeout: T }, async () => {
    const [demo] = await t.db.insert(users).values({ settings: { demo: true } }).returning();
    expect(await setLogin(t.db, demo.id, { username: "demo.name", password: PASSWORD }, { firstOnly: true })).toEqual({
      ok: false,
      error: DEMO_NO_LOGIN,
    });
    const [row] = await t.db.select().from(users).where(eq(users.id, demo.id));
    expect(row).toMatchObject({ username: null, passwordHash: null });
  });
});

describe("changePassword (M5-15)", () => {
  let userId: string;
  beforeEach(async () => {
    const r = await signUp(NAME, PASSWORD, { db: t.db, now: NOW });
    if (!r.ok) throw new Error("setup");
    userId = r.userId;
  });
  const NEW = "a new one";

  it("needs the right current password", { timeout: T }, async () => {
    expect(await changePassword(t.db, userId, WRONG, NEW, { now: NOW })).toEqual({ ok: false, error: WRONG_CURRENT });
    expect((await logIn(NAME, PASSWORD, { db: t.db, now: NOW })).ok).toBe(true);
    expect(await changePassword(t.db, userId, PASSWORD, "four", { now: NOW })).toEqual({
      ok: false,
      error: "Use at least 5 characters.",
    });
    expect(await changePassword(t.db, userId, PASSWORD, NEW, { now: NOW })).toEqual({ ok: true });
    expect(await logIn(NAME, PASSWORD, { db: t.db, now: NOW })).toEqual({ ok: false, error: NO_MATCH });
    expect((await logIn(NAME, NEW, { db: t.db, now: NOW })).ok).toBe(true);
    // Never the passwords in what is stored or counted.
    const stored = JSON.stringify([await t.db.select().from(users), await t.db.select().from(jobs)]);
    for (const secret of [PASSWORD, WRONG, NEW]) expect(stored).not.toContain(secret);
  });

  it("is throttled with log in: the sixth wrong try is refused, even a right one", { timeout: T }, async () => {
    for (let i = 0; i < 5; i++) {
      expect(await changePassword(t.db, userId, WRONG, NEW, { now: at(i * 60_000) })).toEqual({ ok: false, error: WRONG_CURRENT });
    }
    expect(await changePassword(t.db, userId, PASSWORD, NEW, { now: at(5 * 60_000) })).toEqual({ ok: false, error: TOO_MANY });
    // The same count as log in: her name is braked there too.
    expect(await logIn(NAME, PASSWORD, { db: t.db, now: at(5 * 60_000) })).toEqual({ ok: false, error: TOO_MANY });
    // After the wait the right one works.
    expect(await changePassword(t.db, userId, PASSWORD, NEW, { now: at(4 * 60_000 + LOGIN_WINDOW_MS + 1) })).toEqual({ ok: true });
  });

  it("counts wrong log ins, and a right current password clears the name's count", { timeout: T }, async () => {
    for (let i = 0; i < 4; i++) await logIn(NAME, WRONG, { db: t.db, now: NOW });
    expect(await changePassword(t.db, userId, PASSWORD, NEW, { now: NOW })).toEqual({ ok: true });
    for (let i = 0; i < 5; i++) {
      expect(await changePassword(t.db, userId, WRONG, PASSWORD, { now: NOW })).toEqual({ ok: false, error: WRONG_CURRENT });
    }
    expect(await logIn(NAME, NEW, { db: t.db, now: NOW })).toEqual({ ok: false, error: TOO_MANY });
  });

  it("counts the address too", { timeout: T }, async () => {
    const address = "203.0.113.9";
    for (let i = 0; i < 20; i++) await logIn(`guess.${i}`, WRONG, { db: t.db, now: NOW, address });
    expect(await changePassword(t.db, userId, PASSWORD, NEW, { now: NOW, address })).toEqual({ ok: false, error: TOO_MANY });
    expect(await changePassword(t.db, userId, PASSWORD, NEW, { now: NOW, address: "198.51.100.3" })).toEqual({ ok: true });
  });

  it("refuses an account without a login", { timeout: T }, async () => {
    const [plain] = await t.db.insert(users).values({}).returning();
    expect((await changePassword(t.db, plain.id, PASSWORD, NEW)).ok).toBe(false);
  });
});

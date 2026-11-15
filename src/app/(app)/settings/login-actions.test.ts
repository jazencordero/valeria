// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_NO_LOGIN, HAS_LOGIN, logIn, LOGIN_WINDOW_MS, signUp, TAKEN, TOO_MANY, WRONG_CURRENT } from "@/server/auth/accounts";
import type { Db } from "@/server/db/client";
import { users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";

// The actions read the app database and the signed-in user; point both at this test.
const holder = vi.hoisted(() => ({ db: undefined as unknown, userId: null as string | null }));
vi.mock("@/server/db/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db/client")>();
  const db = new Proxy({} as Db, {
    get(_t, prop) {
      const target = holder.db as Db;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...real, db };
});
vi.mock("@/server/auth/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/auth/session")>();
  return {
    ...real,
    currentUser: async () => {
      if (!holder.userId) throw new real.NotSignedIn();
      const [user] = await (holder.db as Db).select().from(users).where(eq(users.id, holder.userId));
      return user;
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "203.0.113.20" }) }));

const { changePasswordAction, changePasswordFor, setLoginAction, setLoginFor } = await import("./login-actions");

// Invented names and passwords only.
const PASSWORD = "correct horse";
const WRONG = "battery staple";
const NEW = "a new one";
const NOW = new Date("2026-11-15T10:00:00Z");

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  holder.db = t.db;
  holder.userId = null;
});
afterEach(async () => {
  await t.close();
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const START = { error: null, username: "", savedAs: null };
const at = (ms: number) => new Date(NOW.getTime() + ms);

async function plainUser(settings: Record<string, unknown> = {}) {
  const [u] = await t.db.insert(users).values({ settings }).returning();
  return u.id;
}

describe("setLoginFor", () => {
  it("sets a login on an account without one", async () => {
    const id = await plainUser({ seededFrom: { key: "k" } });
    expect(await setLoginFor(t.db, id, form({ username: "Own.Name", password: PASSWORD }))).toEqual({
      error: null,
      username: "",
      savedAs: "own.name",
    });
    const r = await logIn("own.name", PASSWORD, { db: t.db });
    expect(r.ok && r.userId).toBe(id);
  });

  it("refuses a taken name with sign up's sentence and keeps what she typed", async () => {
    expect((await signUp("taken.name", PASSWORD, { db: t.db })).ok).toBe(true);
    const id = await plainUser();
    expect(await setLoginFor(t.db, id, form({ username: "Taken.Name", password: PASSWORD }))).toEqual({
      error: TAKEN,
      username: "Taken.Name",
      savedAs: null,
    });
  });

  it("asks for both fields", async () => {
    const id = await plainUser();
    expect((await setLoginFor(t.db, id, form({ username: " ", password: PASSWORD }))).error).toBe("Pick a username.");
    expect((await setLoginFor(t.db, id, form({ username: "own.name" }))).error).toBe("Pick a password.");
  });

  it("refuses a demo", async () => {
    const id = await plainUser({ demo: true });
    expect((await setLoginFor(t.db, id, form({ username: "demo.name", password: PASSWORD }))).error).toBe(DEMO_NO_LOGIN);
  });

  it("does not give an account with a login a new username", async () => {
    const r = await signUp("first.name", PASSWORD, { db: t.db });
    if (!r.ok) throw new Error("setup");
    expect((await setLoginFor(t.db, r.userId, form({ username: "second.name", password: NEW }))).error).toBe(HAS_LOGIN);
    const [row] = await t.db.select().from(users).where(eq(users.id, r.userId));
    expect(row.username).toBe("first.name");
    expect((await logIn("first.name", PASSWORD, { db: t.db })).ok).toBe(true);
  });
});

describe("changePasswordFor", () => {
  it("needs the right current password and is throttled like log in", async () => {
    const r = await signUp("own.name", PASSWORD, { db: t.db, now: NOW });
    if (!r.ok) throw new Error("setup");
    for (let i = 0; i < 5; i++) {
      expect(await changePasswordFor(t.db, r.userId, form({ current: WRONG, next: NEW }), { now: at(i * 1000) })).toEqual({
        error: WRONG_CURRENT,
        changed: false,
      });
    }
    // The sixth try is refused, even with the right password.
    expect(await changePasswordFor(t.db, r.userId, form({ current: PASSWORD, next: NEW }), { now: at(5000) })).toEqual({
      error: TOO_MANY,
      changed: false,
    });
    const later = at(4000 + LOGIN_WINDOW_MS + 1);
    expect(await changePasswordFor(t.db, r.userId, form({ current: PASSWORD, next: NEW }), { now: later })).toEqual({
      error: null,
      changed: true,
    });
    expect((await logIn("own.name", NEW, { db: t.db, now: later })).ok).toBe(true);
  });

  it("asks for both fields", async () => {
    const r = await signUp("own.name", PASSWORD, { db: t.db });
    if (!r.ok) throw new Error("setup");
    expect((await changePasswordFor(t.db, r.userId, form({ next: NEW }))).error).toBe("Type your current password.");
    expect((await changePasswordFor(t.db, r.userId, form({ current: PASSWORD }))).error).toBe("Type a new password.");
  });
});

describe("the actions", () => {
  it("act on the signed-in user only, whatever user id the form carries", async () => {
    const mine = await plainUser();
    const other = await plainUser();
    holder.userId = mine;
    const state = await setLoginAction(START, form({ username: "mine.name", password: PASSWORD, userId: other, id: other }));
    expect(state.savedAs).toBe("mine.name");
    const [a] = await t.db.select().from(users).where(eq(users.id, mine));
    const [b] = await t.db.select().from(users).where(eq(users.id, other));
    expect(a.username).toBe("mine.name");
    expect(b.username).toBeNull();

    const changed = await changePasswordAction(
      { error: null, changed: false },
      form({ current: PASSWORD, next: NEW, userId: other }),
    );
    expect(changed).toEqual({ error: null, changed: true });
    expect((await logIn("mine.name", NEW, { db: t.db })).ok).toBe(true);
  });

  it("do nothing when signed out", async () => {
    const id = await plainUser();
    const state = await setLoginAction(START, form({ username: "own.name", password: PASSWORD, userId: id }));
    expect(state.savedAs).toBeNull();
    expect(state.error).not.toBeNull();
    const [row] = await t.db.select().from(users).where(eq(users.id, id));
    expect(row.username).toBeNull();
    expect((await changePasswordAction({ error: null, changed: false }, form({ current: PASSWORD, next: NEW }))).changed).toBe(false);
  });

  it("refuse a demo", async () => {
    holder.userId = await plainUser({ demo: true });
    expect((await setLoginAction(START, form({ username: "demo.name", password: PASSWORD }))).error).toBe(DEMO_NO_LOGIN);
  });
});

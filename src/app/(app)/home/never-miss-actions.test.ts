// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db/client";
import { calendarFeeds } from "@/server/db/schema/calendar";
import { users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";

// The actions take the user from the session cookie, the origin from the request and
// the app's `db`. All three are swapped for the test's.
const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  userId: "",
  origin: null as string | null,
}));

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
      return { id: holder.userId };
    },
  };
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(holder.origin ? { origin: holder.origin } : {}),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const {
  dismissNeverMiss,
  dismissNeverMissFor,
  InvalidChoice,
  originOf,
  turnOffNeverMiss,
  turnOffNeverMissFor,
  turnOnNeverMiss,
  turnOnNeverMissFor,
} = await import("./never-miss-actions");
const { hashToken, userForToken } = await import("@/server/calendar/feed");

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const ORIGIN = "https://ready.example";

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  holder.db = t.db;
  holder.userId = "";
  holder.origin = null;
});
afterEach(() => t.close());

async function user(settings: Record<string, unknown> = {}) {
  const [u] = await t.db.insert(users).values({ settings }).returning();
  return u;
}

async function settingsOf(userId: string) {
  const [row] = await t.db.select({ settings: users.settings }).from(users).where(eq(users.id, userId));
  return row.settings;
}

async function feedOf(userId: string) {
  const [row] = await t.db.select().from(calendarFeeds).where(eq(calendarFeeds.userId, userId));
  return row ?? null;
}

/** The raw token inside a Google subscribe page. */
function tokenIn(subscribeUrl: string): string {
  const cid = new URL(subscribeUrl).searchParams.get("cid") ?? "";
  const m = /\/api\/cal\/([A-Za-z0-9_-]{43})\.ics$/.exec(cid);
  if (!m) throw new Error("no token in the subscribe page");
  return m[1];
}

describe("turnOnNeverMissFor", () => {
  it("makes her link, answers with Google's subscribe page and saves the choice", async () => {
    const u = await user({ demo: true, ai: { useFiles: true } });

    const { subscribeUrl } = await turnOnNeverMissFor(t.db, u.id, { calendar: "google", reminders: null }, ORIGIN);

    const url = new URL(subscribeUrl);
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("cid")).toMatch(/^webcal:\/\/ready\.example\/api\/cal\/[A-Za-z0-9_-]{43}\.ics$/);

    const token = tokenIn(subscribeUrl);
    expect(await userForToken(token, t.db)).toBe(u.id);
    const feed = await feedOf(u.id);
    expect(feed).toMatchObject({ provider: "google", tokenHash: hashToken(token) });

    const settings = await settingsOf(u.id);
    expect(settings.neverMiss).toMatchObject({ calendar: "google", reminders: null });
    expect(typeof (settings.neverMiss as { at: unknown }).at).toBe("string");
    // Other keys stay.
    expect(settings.demo).toBe(true);
    expect(settings.ai).toEqual({ useFiles: true });
  });

  it("gives Apple and Outlook their own subscribe pages", async () => {
    const u = await user();
    const apple = await turnOnNeverMissFor(t.db, u.id, { calendar: "apple", reminders: null }, ORIGIN);
    expect(apple.subscribeUrl).toMatch(/^webcal:\/\/ready\.example\/api\/cal\/[A-Za-z0-9_-]{43}\.ics$/);
    const outlook = await turnOnNeverMissFor(t.db, u.id, { calendar: "outlook", reminders: null }, ORIGIN);
    expect(outlook.subscribeUrl).toMatch(/^https:\/\/outlook\.live\.com\/calendar\/0\/addfromweb\?url=/);
    expect((await settingsOf(u.id)).neverMiss).toMatchObject({ calendar: "outlook" });
  });

  it("replaces an earlier link, which stops working", async () => {
    const u = await user();
    const first = await turnOnNeverMissFor(t.db, u.id, { calendar: "google", reminders: null }, ORIGIN);
    const second = await turnOnNeverMissFor(t.db, u.id, { calendar: "google", reminders: null }, ORIGIN);
    expect(await userForToken(tokenIn(first.subscribeUrl), t.db)).toBeNull();
    expect(await userForToken(tokenIn(second.subscribeUrl), t.db)).toBe(u.id);
  });

  it("refuses anything Home does not offer, and writes nothing", async () => {
    const u = await user({ demo: true });
    const bad: unknown[] = [
      null,
      "google",
      {},
      { calendar: "yahoo", reminders: null },
      { calendar: null, reminders: null },
      { calendar: "google", reminders: "push" },
      { calendar: "google", reminders: "email", email: "someone@example.com" },
      { calendar: "google" },
    ];
    for (const input of bad) {
      await expect(turnOnNeverMissFor(t.db, u.id, input, ORIGIN)).rejects.toBeInstanceOf(InvalidChoice);
    }
    expect(await feedOf(u.id)).toBeNull();
    expect(await settingsOf(u.id)).toEqual({ demo: true });
  });
});

describe("turnOffNeverMissFor", () => {
  it("revokes her link and forgets the choice, keeping other settings", async () => {
    const u = await user({ demo: true });
    const { subscribeUrl } = await turnOnNeverMissFor(t.db, u.id, { calendar: "google", reminders: null }, ORIGIN);

    await turnOffNeverMissFor(t.db, u.id);

    expect(await userForToken(tokenIn(subscribeUrl), t.db)).toBeNull();
    expect(await feedOf(u.id)).toBeNull();
    expect(await settingsOf(u.id)).toEqual({ demo: true });
  });

  it("leaves another user's link alone", async () => {
    const u = await user();
    const other = await user();
    const theirs = await turnOnNeverMissFor(t.db, other.id, { calendar: "google", reminders: null }, ORIGIN);
    await turnOffNeverMissFor(t.db, u.id);
    expect(await userForToken(tokenIn(theirs.subscribeUrl), t.db)).toBe(other.id);
  });
});

describe("dismissNeverMissFor", () => {
  it("saves when she said Not now, keeping other settings", async () => {
    const u = await user({ demo: true });
    const at = new Date("2026-11-15T08:00:00Z");
    await dismissNeverMissFor(t.db, u.id, at);
    expect(await settingsOf(u.id)).toEqual({ demo: true, neverMiss: { notNowAt: at.toISOString() } });
  });

  it("keeps a saved choice next to it", async () => {
    const u = await user();
    await turnOnNeverMissFor(t.db, u.id, { calendar: "apple", reminders: null }, ORIGIN);
    await dismissNeverMissFor(t.db, u.id);
    expect((await settingsOf(u.id)).neverMiss).toMatchObject({ calendar: "apple", notNowAt: expect.any(String) });
  });

  it("is cleared by turning on, and by turning off", async () => {
    const u = await user();
    await dismissNeverMissFor(t.db, u.id);
    await turnOnNeverMissFor(t.db, u.id, { calendar: "google", reminders: null }, ORIGIN);
    expect((await settingsOf(u.id)).neverMiss).not.toHaveProperty("notNowAt");
    await dismissNeverMissFor(t.db, u.id);
    await turnOffNeverMissFor(t.db, u.id);
    expect(await settingsOf(u.id)).toEqual({});
  });
});

describe("originOf", () => {
  it("takes the request's origin, only http(s)", () => {
    const h = (origin?: string) => new Headers(origin ? { origin } : {});
    expect(originOf(h("https://preview-123.vercel.app"))).toBe("https://preview-123.vercel.app");
    expect(originOf(h("http://localhost:4358"))).toBe("http://localhost:4358");
    expect(originOf(h())).toBeUndefined();
    expect(originOf(h("null"))).toBeUndefined();
    expect(originOf(h("javascript:alert(1)"))).toBeUndefined();
  });
});

describe("the actions", () => {
  it("use the user from the cookie and the request's origin", async () => {
    const u = await user();
    holder.userId = u.id;
    holder.origin = "https://preview.example";

    const { subscribeUrl } = await turnOnNeverMiss({ calendar: "google", reminders: null });
    expect(new URL(subscribeUrl).searchParams.get("cid")).toMatch(/^webcal:\/\/preview\.example\/api\/cal\//);
    expect(await userForToken(tokenIn(subscribeUrl), t.db)).toBe(u.id);

    await turnOffNeverMiss();
    expect(await feedOf(u.id)).toBeNull();

    await dismissNeverMiss();
    expect((await settingsOf(u.id)).neverMiss).toMatchObject({ notNowAt: expect.any(String) });
  });

  it("ignore a user id sent by the browser", async () => {
    const u = await user();
    const other = await user();
    holder.userId = u.id;
    await turnOnNeverMiss({ calendar: "google", reminders: null, userId: other.id });
    expect(await feedOf(u.id)).not.toBeNull();
    expect(await feedOf(other.id)).toBeNull();
  });

  it("reject when she is signed out, and write nothing", async () => {
    const u = await user();
    await expect(turnOnNeverMiss({ calendar: "google", reminders: null })).rejects.toThrow();
    await expect(turnOffNeverMiss()).rejects.toThrow();
    await expect(dismissNeverMiss()).rejects.toThrow();
    expect(await feedOf(u.id)).toBeNull();
    expect(await settingsOf(u.id)).toEqual({});
  });
});

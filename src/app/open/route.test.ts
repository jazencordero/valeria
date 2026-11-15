// @vitest-environment node
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentUserFor, hashToken, SESSION_COOKIE } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { confirmCodes, users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { mintOpenLink, OPEN_TTL_MS } from "@/server/study/seed-account";

// The route reads the app database; point it at this test's fresh PGlite.
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
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

const { GET } = await import("./route");

const T = 90_000;
vi.setConfig({ testTimeout: T, hookTimeout: T });

let t: TestDb;
let userId: string;
beforeEach(async () => {
  t = await createTestDb();
  holder.db = t.db;
  [{ id: userId }] = await t.db.insert(users).values({ settings: { seededFrom: { key: "k", pulledAt: null } } }).returning();
});
afterEach(async () => {
  await t.close();
});

const open = (code: string | null) =>
  GET(new NextRequest(`http://localhost:3000/open${code === null ? "" : `?code=${encodeURIComponent(code)}`}`));

function sessionToken(res: Response): string | null {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return cookie ? cookie.slice(SESSION_COOKIE.length + 1).split(";")[0] : null;
}

async function expectRefused(res: Response) {
  expect(res.status).toBe(403);
  expect(sessionToken(res)).toBeNull();
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("cache-control")).toBe("no-store");
  // The same sentence for every failure: nothing about why.
  expect(await res.text()).toBe("This link does not work any more. Ask for a new one.");
}

describe("GET /open", () => {
  it("works once: sets a session cookie for that user and goes to /home", async () => {
    const { code } = await mintOpenLink(t.db, userId);
    const res = await open(code);
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/home");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const token = sessionToken(res);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect((await currentUserFor(t.db, token!)).id).toBe(userId);
    // The code is a new random token, not the session's.
    expect(token).not.toBe(code);

    await expectRefused(await open(code));
  });

  it("refuses an expired code", async () => {
    const past = new Date(Date.now() - OPEN_TTL_MS - 1000);
    const { code } = await mintOpenLink(t.db, userId, past);
    await expectRefused(await open(code));
    const [row] = await t.db.select().from(confirmCodes);
    expect(row.usedAt).toBeNull();
  });

  it("refuses a code made for another purpose", async () => {
    const code = "A".repeat(43);
    await t.db.insert(confirmCodes).values({ userId, purpose: "handin", payloadHash: hashToken(code), expiresAt: new Date(Date.now() + 60_000) });
    await expectRefused(await open(code));
    const [row] = await t.db.select().from(confirmCodes).where(eq(confirmCodes.purpose, "handin"));
    expect(row.usedAt).toBeNull();
  });

  it("refuses no code, a malformed code and an unknown one", async () => {
    await mintOpenLink(t.db, userId);
    await expectRefused(await open(null));
    await expectRefused(await open("short"));
    await expectRefused(await open("B".repeat(43)));
  });

  it("lets only one of two requests with the same code in", async () => {
    const { code } = await mintOpenLink(t.db, userId);
    const results = await Promise.all([open(code), open(code)]);
    expect(results.map((r) => r.status).sort()).toEqual([303, 403]);
  });
});

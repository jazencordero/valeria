// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILS_PER_ADDRESS, logIn, NO_MATCH, signUp, TOO_MANY } from "@/server/auth/accounts";
import { currentUserFor, SESSION_COOKIE } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { sessions } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";

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

const { POST } = await import("./route");

const T = 90_000;
vi.setConfig({ testTimeout: T, hookTimeout: T });

// Invented only: never a real name or password.
const NAME = "test.student";
const PASSWORD = "correct horse";
const URL_HERE = "http://localhost:3000/api/login";

let t: TestDb;
let userId: string;
let logged: unknown[];
beforeEach(async () => {
  t = await createTestDb();
  holder.db = t.db;
  const made = await signUp(NAME, PASSWORD, { db: t.db });
  if (!made.ok) throw new Error("sign up failed");
  userId = made.userId;
  logged = [];
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation((...a: unknown[]) => void logged.push(...a));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest(URL_HERE, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/login", () => {
  it("logs in to an account: the session is in the cookie only, with the options the screen's log in uses", async () => {
    const before = (await t.db.select().from(sessions)).length;
    const res = await post({ username: "Test.Student ", password: PASSWORD }, { "user-agent": "seed-tool-test" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true });

    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const token = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(cookies[0])?.[1];
    expect(token).toBeDefined();
    expect(text).not.toContain(token!);
    expect(cookies[0]).toMatch(/HttpOnly/i);
    expect(cookies[0]).toMatch(/SameSite=lax/i);
    expect(cookies[0]).toMatch(/Path=\//);
    expect(cookies[0]).toMatch(/Secure/i); // not a development server here
    expect(cookies[0]).toMatch(/Max-Age=\d+/);

    // The cookie is a session of that account, and one more session row is all that changed.
    expect((await currentUserFor(t.db, token)).id).toBe(userId);
    expect(await t.db.select().from(sessions)).toHaveLength(before + 1);
    expect(logged).toEqual([]);
  });

  it("gives one answer for a wrong password and for a name nobody has, and no cookie", async () => {
    const wrong = await post({ username: NAME, password: "not the password" });
    const unknown = await post({ username: "nobody.here", password: PASSWORD });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(await wrong.json()).toEqual({ error: "no_match", message: NO_MATCH });
    expect(await unknown.json()).toEqual({ error: "no_match", message: NO_MATCH });
    expect(logged).toEqual([]);
  });

  it("counts tries together with the log-in screen: 3 wrong there and 2 wrong here, and the next is refused at both doors", async () => {
    // The screen's action calls `logIn` with the typed name and the host's address; so does the route.
    const address = "203.0.113.7";
    for (let i = 0; i < 3; i++) expect(await logIn(NAME, "wrong", { db: t.db, address })).toEqual({ ok: false, error: NO_MATCH });
    for (let i = 0; i < 2; i++) expect((await post({ username: NAME.toUpperCase(), password: "wrong" }, { "x-real-ip": address })).status).toBe(401);

    // The sixth try, with the right password, at either door and from any address.
    const here = await post({ username: NAME, password: PASSWORD }, { "x-real-ip": "198.51.100.1" });
    expect(here.status).toBe(429);
    expect(here.headers.get("retry-after")).toBe("900");
    expect(here.headers.getSetCookie()).toEqual([]);
    expect(await here.json()).toEqual({ error: "too_many", message: TOO_MANY });
    expect(await logIn(NAME, PASSWORD, { db: t.db, address })).toEqual({ ok: false, error: TOO_MANY });

    // The other way round, for another name: 5 wrong here, and the screen's door is shut too.
    const other = "other.student";
    expect((await signUp(other, PASSWORD, { db: t.db })).ok).toBe(true);
    for (let i = 0; i < 5; i++) expect((await post({ username: other, password: "wrong" })).status).toBe(401);
    expect(await logIn(other, PASSWORD, { db: t.db })).toEqual({ ok: false, error: TOO_MANY });
    expect((await post({ username: other, password: PASSWORD })).status).toBe(429);
    expect(logged).toEqual([]);
  });

  it("counts tries per address with the screen too, by the address the host reports", async () => {
    const address = "203.0.113.9";
    // Half at each door, each for another name, all from one address.
    for (let i = 0; i < FAILS_PER_ADDRESS; i++) {
      if (i % 2) expect((await post({ username: `guess.${i}`, password: "wrong" }, { "x-forwarded-for": `${address}, 10.0.0.1` })).status).toBe(401);
      else expect(await logIn(`guess.${i}`, "wrong", { db: t.db, address })).toEqual({ ok: false, error: NO_MATCH });
    }
    expect((await post({ username: NAME, password: PASSWORD }, { "x-real-ip": address })).status).toBe(429);
    expect(await logIn(NAME, PASSWORD, { db: t.db, address })).toEqual({ ok: false, error: TOO_MANY });
    // From somewhere else she still gets in.
    expect((await post({ username: NAME, password: PASSWORD }, { "x-real-ip": "198.51.100.2" })).status).toBe(200);
  });

  it("takes JSON only, nothing a browser sends from another site, and nothing large or misshapen", async () => {
    const good = { username: NAME, password: PASSWORD };
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
      const res = await post(good, { "content-type": type });
      expect(res.status).toBe(415);
      expect(await res.json()).toMatchObject({ error: "wrong_type" });
    }
    const elsewhere: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "https://elsewhere.example", host: "localhost:3000" },
      { origin: "null" },
      { origin: "http://localhost:3000", "x-forwarded-host": "ready.example" },
    ];
    for (const headers of elsewhere) {
      const res = await post(good, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "cross_site" });
    }
    const big = JSON.stringify({ ...good, padding: "x".repeat(5000) });
    for (const res of [await post(big), await post(big, { "content-length": "20" }), await post(good, { "content-length": "5000" })]) {
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: "too_large" });
    }
    for (const body of ["", "{not json", "[]", '"text"', "{}", { username: NAME }, { password: PASSWORD }, { username: 12, password: PASSWORD }, { username: NAME, password: ["x"] }, { username: "  ", password: PASSWORD }, { username: NAME, password: "" }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.headers.getSetCookie()).toEqual([]);
      const answer = (await res.json()) as { error: string; message: string };
      expect(answer.error).toBe("invalid");
      expect(answer.message).not.toContain(PASSWORD);
    }
    // None of these was a try: the brake has counted nothing, and no session was made by them.
    expect(await t.db.select().from(sessions)).toHaveLength(1);
    expect((await post(good, { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await post(good, { "content-type": "application/json; charset=utf-8" })).status).toBe(200);
    expect(logged).toEqual([]);
  });
});

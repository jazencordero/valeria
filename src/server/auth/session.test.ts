// @vitest-environment node
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { notes } from "@/server/db/schema/learn";
import { sessions, users } from "@/server/db/schema/users";
import { assignments, chatMessages, chats } from "@/server/db/schema/work";
import {
  currentUserFor,
  ensureSessionFor,
  hashToken,
  mergeUsers,
  newToken,
  NotSignedIn,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  sessionCookieOptions,
  signOutEverywhere,
} from "./session";

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

describe("ensureSessionFor", () => {
  it("creates a user and a session for an unknown cookie", async () => {
    const token = newToken();
    const result = await ensureSessionFor(t.db, token);

    expect(result.token).toBe(token);
    expect(result.newToken).toBe(false);
    expect(await t.db.select().from(users)).toHaveLength(1);
    const [session] = await t.db.select().from(sessions);
    expect(session.userId).toBe(result.user.id);
  });

  it("stores only the sha256 hash, never the raw token", async () => {
    const token = newToken();
    await ensureSessionFor(t.db, token);

    const [session] = await t.db.select().from(sessions);
    expect(session.tokenHash).not.toBe(token);
    expect(session.tokenHash).toBe(hashToken(token));
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same user for a known cookie", async () => {
    const token = newToken();
    const first = await ensureSessionFor(t.db, token);
    const second = await ensureSessionFor(t.db, token);

    expect(second.user.id).toBe(first.user.id);
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it("mints a fresh token when the cookie is missing or malformed", async () => {
    for (const bad of [undefined, "", "not-a-token"]) {
      const result = await ensureSessionFor(t.db, bad);
      expect(result.newToken).toBe(true);
      expect(result.token).not.toBe(bad);
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(await t.db.select().from(users)).toHaveLength(3);
  });

  it("two parallel first visits with one token end up with one user", async () => {
    const token = newToken();
    const [a, b] = await Promise.all([ensureSessionFor(t.db, token), ensureSessionFor(t.db, token)]);
    expect(a.user.id).toBe(b.user.id);
    expect(await t.db.select().from(users)).toHaveLength(1);
  });
});

describe("currentUserFor", () => {
  it("throws NotSignedIn for a missing or unknown cookie", async () => {
    await expect(currentUserFor(t.db, undefined)).rejects.toBeInstanceOf(NotSignedIn);
    await expect(currentUserFor(t.db, newToken())).rejects.toBeInstanceOf(NotSignedIn);
  });

  it("returns the user and moves last_seen_at at most once an hour", async () => {
    const token = newToken();
    const { user } = await ensureSessionFor(t.db, token);
    const start = new Date("2026-01-01T10:00:00Z");
    await t.db.update(sessions).set({ lastSeenAt: start });
    const seen = async () => (await t.db.select().from(sessions))[0].lastSeenAt.getTime();

    expect((await currentUserFor(t.db, token, new Date("2026-01-01T10:30:00Z"))).id).toBe(user.id);
    expect(await seen()).toBe(start.getTime());

    const later = new Date("2026-01-01T11:00:00Z");
    await currentUserFor(t.db, token, later);
    expect(await seen()).toBe(later.getTime());
  });
});

describe("signOutEverywhere", () => {
  it("deletes every session of that user only", async () => {
    const a1 = newToken();
    const { user: a } = await ensureSessionFor(t.db, a1);
    const a2 = newToken();
    await t.db.insert(sessions).values({ userId: a.id, tokenHash: hashToken(a2) });
    const b = newToken();
    await ensureSessionFor(t.db, b);

    await signOutEverywhere(a.id, t.db);

    await expect(currentUserFor(t.db, a1)).rejects.toBeInstanceOf(NotSignedIn);
    await expect(currentUserFor(t.db, a2)).rejects.toBeInstanceOf(NotSignedIn);
    await expect(currentUserFor(t.db, b)).resolves.toBeTruthy();
  });
});

describe("mergeUsers", () => {
  async function newUser() {
    const token = newToken();
    const { user } = await ensureSessionFor(t.db, token);
    return { user, token };
  }
  async function course(userId: string, moodleId: number) {
    const [row] = await t.db
      .insert(courses)
      .values({ userId, moodleId, name: `Course ${moodleId}` })
      .returning();
    return row;
  }
  async function assignment(userId: string, courseId: string, moodleId: number) {
    const [row] = await t.db
      .insert(assignments)
      .values({ userId, courseId, moodleId, name: `Assignment ${moodleId}` })
      .returning();
    return row;
  }

  it("moves an assignment and a session and deletes the source user", async () => {
    const from = await newUser();
    const into = await newUser();
    const c = await course(from.user.id, 101);
    const a = await assignment(from.user.id, c.id, 9001);

    await mergeUsers(from.user.id, into.user.id, t.db);

    const [moved] = await t.db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(moved.userId).toBe(into.user.id);
    expect((await currentUserFor(t.db, from.token)).id).toBe(into.user.id);
    expect((await currentUserFor(t.db, into.token)).id).toBe(into.user.id);
    expect(await t.db.select().from(users).where(eq(users.id, from.user.id))).toHaveLength(0);
  });

  it("on a unique-key clash keeps the target's row and re-points what hung off the source's", async () => {
    const from = await newUser();
    const into = await newUser();
    // Same Moodle course and assignment synced on both devices.
    const fromCourse = await course(from.user.id, 101);
    const intoCourse = await course(into.user.id, 101);
    const fromA = await assignment(from.user.id, fromCourse.id, 9001);
    const intoA = await assignment(into.user.id, intoCourse.id, 9001);
    // Each device also chatted about it (chats.assignment_id is unique).
    const [fromChat] = await t.db.insert(chats).values({ userId: from.user.id, assignmentId: fromA.id }).returning();
    const [intoChat] = await t.db.insert(chats).values({ userId: into.user.id, assignmentId: intoA.id }).returning();
    await t.db.insert(chatMessages).values({ chatId: fromChat.id, role: "user", parts: ["from"] });
    await t.db.insert(chatMessages).values({ chatId: intoChat.id, role: "user", parts: ["into"] });
    // Her note on the source copy of the course (SET NULL FK) must survive.
    const [note] = await t.db
      .insert(notes)
      .values({ userId: from.user.id, body: "keep me", courseId: fromCourse.id, assignmentId: fromA.id })
      .returning();
    // One Moodle connection per user (user_id unique): the target's wins.
    const conn = { siteUrl: "https://mycourses.example", moodleUserId: 1, tokenSealed: "x" };
    await t.db.insert(moodleConnections).values({ ...conn, userId: from.user.id, tokenSealed: "from" });
    await t.db.insert(moodleConnections).values({ ...conn, userId: into.user.id, tokenSealed: "into" });

    await mergeUsers(from.user.id, into.user.id, t.db);

    expect((await t.db.select().from(courses)).map((r) => r.id)).toEqual([intoCourse.id]);
    expect((await t.db.select().from(assignments)).map((r) => r.id)).toEqual([intoA.id]);
    expect((await t.db.select().from(chats)).map((r) => r.id)).toEqual([intoChat.id]);
    const messages = await t.db.select().from(chatMessages);
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.chatId === intoChat.id)).toBe(true);
    const [keptNote] = await t.db.select().from(notes).where(eq(notes.id, note.id));
    expect(keptNote).toMatchObject({ userId: into.user.id, courseId: intoCourse.id, assignmentId: intoA.id });
    const conns = await t.db.select().from(moodleConnections);
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ userId: into.user.id, tokenSealed: "into" });
  });

  it("hands the source's username and password to a target that has none (M5-14)", async () => {
    // Invented names and hash strings only.
    const from = await newUser();
    const into = await newUser();
    await t.db.update(users).set({ username: "test.student", passwordHash: "scrypt$invented" }).where(eq(users.id, from.user.id));
    await mergeUsers(from.user.id, into.user.id, t.db);
    const [kept] = await t.db.select().from(users).where(eq(users.id, into.user.id));
    expect(kept).toMatchObject({ username: "test.student", passwordHash: "scrypt$invented" });
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it("keeps the target's own username and password when both have one (M5-14)", async () => {
    const from = await newUser();
    const into = await newUser();
    await t.db.update(users).set({ username: "test.source", passwordHash: "scrypt$source" }).where(eq(users.id, from.user.id));
    await t.db.update(users).set({ username: "test.target", passwordHash: "scrypt$target" }).where(eq(users.id, into.user.id));
    await mergeUsers(from.user.id, into.user.id, t.db);
    const rows = await t.db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: into.user.id, username: "test.target", passwordHash: "scrypt$target" });
  });

  it("refuses to merge a user into itself", async () => {
    const { user } = await newUser();
    await expect(mergeUsers(user.id, user.id, t.db)).rejects.toThrow();
  });
});

describe("proxy", () => {
  // M5-14: the proxy no longer mints a cookie; a visitor without one is signed out.
  it("sends a signed-out visitor from an app page to the welcome screen, and mints no cookie", () => {
    for (const path of ["/home", "/settings", "/courses/x", "/connect", "/sorting"]) {
      const res = proxy(new NextRequest(`https://ready.example${path}`));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("https://ready.example/welcome");
      expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    }
    // A malformed cookie counts as none.
    const bad = proxy(new NextRequest("https://ready.example/home", { headers: { cookie: `${SESSION_COOKIE}=nope` } }));
    expect(bad.headers.get("location")).toBe("https://ready.example/welcome");
  });

  it("sends a signed-out visitor starting the first run to sign up", () => {
    const res = proxy(new NextRequest("https://ready.example/school"));
    expect(res.headers.get("location")).toBe("https://ready.example/signup");
  });

  it("lets the public pages through without a cookie", () => {
    for (const path of ["/", "/welcome", "/login", "/signup", "/privacy", "/demo", "/open", "/logout", "/api/sync", "/dev/welcome"]) {
      const res = proxy(new NextRequest(`https://ready.example${path}`));
      expect(res.headers.get("location"), path).toBeNull();
      expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    }
  });

  it("leaves a well-formed cookie alone and lets it through", () => {
    const token = newToken();
    const res = proxy(new NextRequest("https://ready.example/home", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("uses one-year httpOnly lax cookie options for the session", () => {
    expect(sessionCookieOptions()).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_SECONDS });
  });
});

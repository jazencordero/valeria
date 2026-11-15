// @vitest-environment node
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db/client";
import { calendarFeeds, events } from "@/server/db/schema/calendar";
import { courses } from "@/server/db/schema/courses";
import { exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
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

const { GET } = await import("@/app/api/cal/[token]/route");
const { createFeed, hashToken, itemsForToken, itemsForUser, revokeFeed, subscribeLinks, userForToken } = await import("./feed");

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const ORIGIN = "https://ready.example";
const DAY = 24 * 60 * 60 * 1000;
const SOON = new Date(Date.UTC(2030, 0, 10, 12, 0, 0));

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  holder.db = t.db;
});
afterEach(() => t.close());

const tokenOf = (link: string) => link.slice(`${ORIGIN}/api/cal/`.length).replace(/\.ics$/, "");

function fetchFeed(token: string): Promise<Response> {
  return GET(new Request(`${ORIGIN}/api/cal/${token}`), { params: Promise.resolve({ token }) });
}

/** One user with one course and something of each kind. `tag` keeps titles apart between users. */
async function seedUser(tag: string) {
  const db = t.db;
  const [user] = await db.insert(users).values({}).returning();
  const [course] = await db
    .insert(courses)
    .values({ userId: user.id, moodleId: tag === "A" ? 1 : 2, name: `Course ${tag}`, code: `C-${tag}` })
    .returning();
  const [hidden] = await db
    .insert(courses)
    .values({ userId: user.id, moodleId: tag === "A" ? 11 : 12, name: `Hidden ${tag}`, hidden: true })
    .returning();
  await db.insert(assignments).values([
    { userId: user.id, courseId: course.id, moodleId: 100, name: `Essay ${tag}`, dueAt: SOON, state: "open" },
    { userId: user.id, courseId: course.id, moodleId: 101, name: `Draft ${tag}`, dueAt: new Date(SOON.getTime() + DAY), state: "draft" },
    { userId: user.id, courseId: course.id, moodleId: 102, name: `Handed ${tag}`, dueAt: SOON, state: "submitted" },
    { userId: user.id, courseId: course.id, moodleId: 103, name: `Graded ${tag}`, dueAt: SOON, state: "graded" },
    { userId: user.id, courseId: course.id, moodleId: 104, name: `Undated ${tag}`, dueAt: null, state: "open" },
    { userId: user.id, courseId: hidden.id, moodleId: 105, name: `HiddenWork ${tag}`, dueAt: SOON, state: "open" },
  ]);
  const [examEvent] = await db
    .insert(events)
    .values({ userId: user.id, courseId: course.id, kind: "exam", title: `Midterm ${tag}`, startsAt: SOON, source: "moodle", moodleRef: "event:1" })
    .returning();
  await db.insert(events).values([
    { userId: user.id, courseId: course.id, kind: "deadline", title: `Essay ${tag}`, startsAt: SOON, source: "moodle", moodleRef: "event:2" },
    { userId: user.id, courseId: course.id, kind: "quiz", title: `Quiz ${tag}`, startsAt: SOON, source: "moodle", moodleRef: "quiz:3" },
    { userId: user.id, courseId: course.id, kind: "other", title: `Lecture ${tag}`, startsAt: SOON, source: "moodle", moodleRef: "event:4" },
    { userId: user.id, courseId: null, kind: "deadline", title: `Own ${tag}`, startsAt: SOON, source: "manual" },
  ]);
  await db.insert(exams).values({
    userId: user.id,
    courseId: course.id,
    eventId: examEvent.id,
    title: `Midterm (moved) ${tag}`,
    kind: "exam",
    at: new Date(SOON.getTime() + 2 * DAY),
  });
  return user.id;
}

describe("createFeed", () => {
  it("stores only the hash: the raw token is nowhere in the database", async () => {
    const userId = await seedUser("A");
    const { link } = await createFeed(userId, "google", { origin: ORIGIN, db: t.db });
    expect(link).toMatch(/^https:\/\/ready\.example\/api\/cal\/[A-Za-z0-9_-]{43}\.ics$/);
    const token = tokenOf(link);

    const rows = await t.db.select().from(calendarFeeds);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashToken(token));
    expect(rows[0].provider).toBe("google");

    // Every column of every feed row, as text.
    const { rows: raw } = await t.client.query<Record<string, unknown>>("select * from calendar_feeds");
    const dump = JSON.stringify(raw);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(Buffer.from(token, "base64url").toString("hex"));
  });

  it("makes a different token each time, and a new one revokes the old", async () => {
    const userId = await seedUser("A");
    const first = tokenOf((await createFeed(userId, "apple", { origin: ORIGIN, db: t.db })).link);
    const second = tokenOf((await createFeed(userId, "outlook", { origin: ORIGIN, db: t.db })).link);
    expect(second).not.toBe(first);
    expect(await userForToken(first, t.db)).toBeNull();
    expect(await userForToken(second, t.db)).toBe(userId);
    expect(await t.db.select().from(calendarFeeds)).toHaveLength(1);
    expect((await fetchFeed(first)).status).toBe(404);
  });

  it("rejects a provider it does not know", async () => {
    const userId = await seedUser("A");
    await expect(createFeed(userId, "yahoo" as never, { origin: ORIGIN, db: t.db })).rejects.toThrow();
  });
});

describe("GET /api/cal/[token]", () => {
  it("serves the calendar without a session, with the right headers", async () => {
    const userId = await seedUser("A");
    const token = tokenOf((await createFeed(userId, "google", { origin: ORIGIN, db: t.db })).link);

    for (const path of [token, `${token}.ics`]) {
      const res = await fetchFeed(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("private, max-age=900");
      const body = await res.text();
      expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
      expect(body).toContain("X-WR-CALNAME:Ready");
    }
  });

  it("gives 404 for a revoked token", async () => {
    const userId = await seedUser("A");
    const token = tokenOf((await createFeed(userId, "google", { origin: ORIGIN, db: t.db })).link);
    expect((await fetchFeed(token)).status).toBe(200);

    await revokeFeed(userId, t.db);
    const res = await fetchFeed(token);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("VCALENDAR");
    expect(await itemsForToken(token, t.db)).toBeNull();
  });

  it("gives 404 for unknown and malformed tokens", async () => {
    await seedUser("A");
    const unknown = Buffer.alloc(32, 7).toString("base64url");
    for (const token of [unknown, "short", "", `${unknown}x`, "a".repeat(42) + "=", "../../etc"]) {
      expect((await fetchFeed(token)).status).toBe(404);
    }
  });

  it("lists only that user's items, and only the ones still to do", async () => {
    const a = await seedUser("A");
    const b = await seedUser("B");
    const tokenA = tokenOf((await createFeed(a, "google", { origin: ORIGIN, db: t.db })).link);
    await createFeed(b, "google", { origin: ORIGIN, db: t.db });

    const items = (await itemsForToken(tokenA, t.db)) ?? [];
    const titles = items.map((i) => `${i.kind}:${i.title}`).sort();
    expect(titles).toEqual(
      [
        "deadline:Draft A",
        "deadline:Essay A",
        "deadline:Own A",
        "exam:Midterm (moved) A",
        "quiz:Quiz A",
      ].sort(),
    );
    expect(items.find((i) => i.title === "Essay A")?.course).toBe("C-A");

    const body = await (await fetchFeed(tokenA)).text();
    expect(body).toContain("SUMMARY:Due: Essay A");
    expect(body).toContain("SUMMARY:Exam: Midterm (moved) A");
    expect(body).not.toMatch(/ B\r\n/);
    expect(body).not.toContain("Course B");
    expect(body).not.toContain("Handed A");
    expect(body).not.toContain("HiddenWork A");
    expect(body).not.toContain("Lecture A");
    // The Moodle copy of the assignment is not listed a second time.
    expect(body.match(/SUMMARY:Due: Essay A/g)).toHaveLength(1);
  });
});

describe("itemsForUser: an assignment's calendar copy", () => {
  it("lists a deadline once when a hand-made entry repeats an assignment's due time", async () => {
    const userId = await seedUser("A");
    const [course] = await t.db.select().from(courses).where(and(eq(courses.userId, userId), eq(courses.hidden, false)));
    const LATER = new Date(SOON.getTime() + 5 * DAY);
    await t.db.insert(events).values([
      // The calendar's copy of "Essay A" (open) and of "Handed A" (handed in), under their calendar titles.
      { userId, courseId: course.id, kind: "deadline", title: "Essay A is due", startsAt: SOON, source: "manual", moodleRef: "seed:1" },
      // A deadline of the same course at a time no assignment has: her own entry, kept.
      { userId, courseId: course.id, kind: "deadline", title: "Peer review A", startsAt: LATER, source: "manual", moodleRef: "seed:2" },
      // A quiz closing at the same time as the assignment is its own thing, kept.
      { userId, courseId: course.id, kind: "quiz", title: "Essay A: quiz closes", startsAt: SOON, source: "manual", moodleRef: "seed:3" },
    ]);
    const titles = (await itemsForUser(userId, t.db)).map((i) => i.title);
    expect(titles).not.toContain("Essay A is due");
    expect(titles.filter((x) => x === "Essay A")).toHaveLength(1);
    expect(titles).toContain("Peer review A");
    expect(titles).toContain("Essay A: quiz closes");
    // The entry with no course at the same time (seedUser's "Own A") is still hers.
    expect(titles).toContain("Own A");
  });
});

describe("subscribeLinks", () => {
  it("builds the Google, Apple and Outlook addresses", () => {
    const link = `${ORIGIN}/api/cal/${"x".repeat(43)}.ics`;
    const webcal = `webcal://ready.example/api/cal/${"x".repeat(43)}.ics`;
    const links = subscribeLinks(link);
    expect(links.apple).toBe(webcal);
    expect(links.google).toBe(`https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`);
    expect(links.outlook).toBe(
      `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(link)}&name=Ready`,
    );
    const google = new URL(links.google);
    expect(google.searchParams.get("cid")).toBe(webcal);
    const outlook = new URL(links.outlook);
    expect(outlook.searchParams.get("url")).toBe(link);
  });

  it("keeps the port of a local link", () => {
    const links = subscribeLinks("http://localhost:3000/api/cal/abc.ics");
    expect(links.apple).toBe("webcal://localhost:3000/api/cal/abc.ics");
  });
});

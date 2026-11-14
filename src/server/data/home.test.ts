// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { firstNameOf, getHomeView } from "./home";

const NOW = new Date("2026-11-14T15:48:00+02:00");
const CONNECTED = new Date("2026-11-10T10:00:00+02:00");

let t: TestDb;
let moodleId = 1;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

async function user(
  opts: { connected?: boolean; status?: "ok" | "expired" | "revoked" | "error"; name?: string | null } = {},
) {
  const { connected = true, status = "ok", name = null } = opts;
  const [u] = await t.db.insert(users).values({ displayName: name }).returning();
  if (connected) {
    await t.db.insert(moodleConnections).values({
      userId: u.id,
      siteUrl: "https://moodle.example",
      moodleUserId: moodleId++,
      tokenSealed: "sealed",
      connectedAt: CONNECTED,
      status,
    });
  }
  return u;
}

async function course(userId: string, name: string, extra: Partial<typeof courses.$inferInsert> = {}) {
  const [c] = await t.db
    .insert(courses)
    .values({ userId, moodleId: moodleId++, name, ...extra })
    .returning();
  return c;
}

async function assignment(
  userId: string,
  courseId: string,
  name: string,
  extra: Partial<typeof assignments.$inferInsert> = {},
) {
  const [a] = await t.db
    .insert(assignments)
    .values({ userId, courseId, moodleId: moodleId++, name, firstSeenAt: CONNECTED, ...extra })
    .returning();
  return a;
}

describe("getHomeView", () => {
  it("puts the earliest due first and the rest under Then, in order", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods", { code: "ISM-E1005" });
    const sca = await course(u.id, "Supply Chain Analytics", { code: "ISM-E3003" });
    await assignment(u.id, sca.id, "No date");
    await assignment(u.id, sca.id, "Case memo 2", { dueAt: new Date("2026-11-17T23:59:00+02:00") });
    const a3 = await assignment(u.id, fm.id, "Assignment 3: Forecast weekly demand", {
      dueAt: new Date("2026-11-14T21:00:00+02:00"),
      estimateMin: 90,
    });
    await assignment(u.id, fm.id, "Blueprint", { dueAt: new Date("2026-11-19T16:00:00+02:00") });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.first).toMatchObject({
      id: a3.id,
      title: "Assignment 3: Forecast weekly demand",
      course: "Forecasting Methods",
      code: "ISM-E1005",
      estimateMin: 90,
      status: "not_started",
      href: `/assignments/${a3.id}`,
    });
    expect(view.first?.dueAt?.toISOString()).toBe("2026-11-14T19:00:00.000Z");
    expect(view.then.map((a) => a.title)).toEqual(["Case memo 2", "Blueprint", "No date"]);
    expect(view.then[0]).toMatchObject({ course: "Supply Chain Analytics", status: "not_started" });
  });

  it("gives a null code when the course has none", async () => {
    const u = await user();
    const c = await course(u.id, "No code");
    await assignment(u.id, c.id, "Essay", { dueAt: new Date("2026-11-20T12:00:00+02:00") });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.first).toMatchObject({ title: "Essay", code: null });
    expect(view.then).toEqual([]);
  });

  it("gives the newest hand-in of the last 7 days, with its due time, when nothing is open", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    await assignment(u.id, fm.id, "Long ago", { submittedAt: new Date("2026-10-01T10:00:00+03:00") });
    await assignment(u.id, fm.id, "Tuesday", { submittedAt: new Date("2026-11-10T10:00:00+02:00") });
    const a3 = await assignment(u.id, fm.id, "Assignment 3", {
      submittedAt: new Date("2026-11-14T15:52:00+02:00"),
      dueAt: new Date("2026-11-14T21:00:00+02:00"),
      state: "submitted",
    });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.first).toBeNull();
    expect(view.then).toEqual([]);
    expect(view.lastDone).toMatchObject({ id: a3.id, title: "Assignment 3", course: "Forecasting Methods" });
    expect(view.lastDone?.submittedAt.toISOString()).toBe("2026-11-14T13:52:00.000Z");
    expect(view.lastDone?.dueAt?.toISOString()).toBe("2026-11-14T19:00:00.000Z");
  });

  it("gives no done row when the newest hand-in is older than 7 days", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    await assignment(u.id, fm.id, "Old", { submittedAt: new Date("2026-11-07T15:00:00+02:00") });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.first).toBeNull();
    expect(view.lastDone).toBeNull();
  });

  it("leaves out another user's assignments", async () => {
    const u = await user();
    const other = await user();
    const mine = await course(u.id, "Mine");
    const theirs = await course(other.id, "Theirs");
    await assignment(u.id, mine.id, "My memo", { dueAt: new Date("2026-11-18T12:00:00+02:00") });
    await assignment(other.id, theirs.id, "Their earlier one", { dueAt: new Date("2026-11-15T12:00:00+02:00") });
    await assignment(other.id, theirs.id, "Their done", { submittedAt: new Date("2026-11-14T10:00:00+02:00") });
    // Their row in my course still is not mine.
    await assignment(other.id, mine.id, "Their row", { dueAt: new Date("2026-11-15T09:00:00+02:00") });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.first?.title).toBe("My memo");
    expect(view.then).toEqual([]);
    expect(view.lastDone).toBeNull();
  });

  it("leaves out hidden courses and their assignments", async () => {
    const u = await user();
    const shown = await course(u.id, "Shown");
    const old = await course(u.id, "Old course", { hidden: true });
    await assignment(u.id, old.id, "Hidden first", { dueAt: new Date("2026-11-15T09:00:00+02:00") });
    await assignment(u.id, old.id, "Hidden done", { submittedAt: new Date("2026-11-14T10:00:00+02:00") });
    await assignment(u.id, shown.id, "Shown one", { dueAt: new Date("2026-11-18T12:00:00+02:00") });
    await assignment(u.id, shown.id, "Shown two", { dueAt: new Date("2026-11-19T12:00:00+02:00") });

    const view = await getHomeView(u.id, { now: NOW }, t.db);

    expect(view.first?.title).toBe("Shown one");
    expect(view.then.map((a) => a.title)).toEqual(["Shown two"]);
    expect(view.lastDone).toBeNull();
  });

  it("gives the connection status, or null when she never connected", async () => {
    const ok = await user();
    const expired = await user({ status: "expired" });
    const none = await user({ connected: false });

    expect((await getHomeView(ok.id, { now: NOW }, t.db)).connection).toEqual({ status: "ok" });
    expect((await getHomeView(expired.id, { now: NOW }, t.db)).connection).toEqual({ status: "expired" });
    expect((await getHomeView(none.id, { now: NOW }, t.db)).connection).toBeNull();
  });

  it("gives her first name, or null when there is none", async () => {
    const named = await user({ name: "  Valeria Example " });
    const unnamed = await user();

    expect((await getHomeView(named.id, { now: NOW }, t.db)).firstName).toBe("Valeria");
    expect((await getHomeView(unnamed.id, { now: NOW }, t.db)).firstName).toBeNull();
  });
});

describe("firstNameOf", () => {
  it("takes the first word, and null for blank", () => {
    expect(firstNameOf("Valeria Example")).toBe("Valeria");
    expect(firstNameOf("   ")).toBeNull();
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf(undefined)).toBeNull();
  });
});

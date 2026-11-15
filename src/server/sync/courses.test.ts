// @vitest-environment node
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, newToken } from "@/server/auth/session";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { users } from "@/server/db/schema/users";
import { ALLOWED_SITES, connectWithKey } from "@/server/moodle/connect";
import { DEMO_KEY } from "@/server/moodle/fake-inline";
import { getCourses, type Course } from "@/server/moodle/read/courses";
import { NotConnected, nextColor, syncCourses, type SyncCoursesDeps } from "./courses";

// Made-up values for tests only. The fake Moodle accepts DEMO_KEY and nothing else.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const AALTO = ALLOWED_SITES[0];
// The machine can be busy; a fresh database per test takes a while.
const SLOW = 60_000;

let t: TestDb;
beforeEach(async () => {
  vi.stubEnv("MOODLE_FAKE", "1");
  vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
  t = await createTestDb();
}, SLOW);
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

/** A user with the fake Moodle connected. */
async function connectedUser(): Promise<string> {
  const { user } = await ensureSessionFor(t.db, newToken());
  const result = await connectWithKey(user.id, AALTO, DEMO_KEY, t.db);
  if (!result.ok) throw new Error("the fake Moodle rejected the demo key");
  return result.userId;
}

/**
 * The fake Moodle is stateless, so tests change its answer on the way through:
 * `change` gets the fake's real course list and returns what "Moodle" says now.
 */
function fakeWith(change: (list: Course[]) => Course[]): SyncCoursesDeps {
  return { getCourses: async (conn, moodleUserId) => change(await getCourses(conn, moodleUserId)) };
}

async function rowsOf(userId: string) {
  return t.db.select().from(courses).where(eq(courses.userId, userId)).orderBy(asc(courses.moodleId));
}

function madeUp(moodleId: number): Course {
  return { moodleId, code: null, name: `Made-up course ${moodleId}`, shortName: `MADE-${moodleId}` };
}

describe("nextColor", () => {
  it("gives the first free colour in order, then the least used", () => {
    expect(nextColor([])).toBe("butter");
    expect(nextColor(["butter"])).toBe("mint");
    expect(nextColor(["butter", "sky"])).toBe("mint");
    expect(nextColor(["butter", "mint", "sky"])).toBe("blush");
    expect(nextColor(["butter", "mint", "sky", "blush"])).toBe("butter");
    expect(nextColor(["butter", "mint", "sky", "blush", "butter"])).toBe("mint");
  });
});

describe("syncCourses", () => {
  it("first run adds 4, second run adds 0, removing one from the fake hides it", async () => {
    const userId = await connectedUser();

    expect(await syncCourses(userId, t.db)).toEqual({ added: 4, updated: 0, hidden: 0 });
    const first = await rowsOf(userId);
    expect(first).toHaveLength(4);
    expect(first.every((row) => !row.hidden)).toBe(true);

    expect(await syncCourses(userId, t.db)).toEqual({ added: 0, updated: 0, hidden: 0 });
    expect(await rowsOf(userId)).toEqual(first);

    const dropped = first[1].moodleId;
    const without = fakeWith((list) => list.filter((c) => c.moodleId !== dropped));
    expect(await syncCourses(userId, t.db, without)).toEqual({ added: 0, updated: 0, hidden: 1 });

    const after = await rowsOf(userId);
    expect(after).toHaveLength(4); // hidden, never deleted
    expect(after.filter((row) => row.hidden).map((row) => row.moodleId)).toEqual([dropped]);
    // Same row as before, only the flag moved.
    expect(after[1]).toEqual({ ...first[1], hidden: true });

    // Still gone on the next run: nothing new to report.
    expect(await syncCourses(userId, t.db, without)).toEqual({ added: 0, updated: 0, hidden: 0 });
  }, SLOW);

  it("stores what Moodle said about each course", async () => {
    const userId = await connectedUser();
    await syncCourses(userId, t.db);
    const [row] = await rowsOf(userId);
    expect(row).toMatchObject({
      userId,
      moodleId: 3101,
      code: "ISM-E1005",
      name: "Forecasting Methods, Lecture, 1.9.2026-18.12.2026",
      shortName: "ISM-E1005 - Forecasting Methods",
      hidden: false,
    });
  }, SLOW);

  it("gives new courses butter, mint, sky, blush in Moodle's order, then starts again", async () => {
    const userId = await connectedUser();
    const order = (await getCourses({ siteUrl: AALTO, token: DEMO_KEY }, 4242)).map((c) => c.moodleId);
    await syncCourses(userId, t.db);
    const colorOf = new Map((await rowsOf(userId)).map((row) => [row.moodleId, row.color]));
    expect(order.map((id) => colorOf.get(id))).toEqual(["butter", "mint", "sky", "blush"]);

    // All four are in use: a fifth and sixth course repeat the order.
    const more = fakeWith((list) => [...list, madeUp(9001), madeUp(9002)]);
    expect(await syncCourses(userId, t.db, more)).toEqual({ added: 2, updated: 0, hidden: 0 });
    const rows = await rowsOf(userId);
    expect(rows.find((row) => row.moodleId === 9001)?.color).toBe("butter");
    expect(rows.find((row) => row.moodleId === 9002)?.color).toBe("mint");
  }, SLOW);

  it("reuses the colour of a hidden course for the next new one", async () => {
    const userId = await connectedUser();
    await syncCourses(userId, t.db);
    const mint = (await rowsOf(userId)).find((row) => row.color === "mint");
    if (!mint) throw new Error("no mint course after the first sync");

    // The mint course leaves and a new one arrives in the same run.
    const swapped = fakeWith((list) => [...list.filter((c) => c.moodleId !== mint.moodleId), madeUp(9001)]);
    expect(await syncCourses(userId, t.db, swapped)).toEqual({ added: 1, updated: 0, hidden: 1 });
    expect((await rowsOf(userId)).find((row) => row.moodleId === 9001)?.color).toBe("mint");
  }, SLOW);

  it("counts a changed title as updated and keeps the row and its colour", async () => {
    const userId = await connectedUser();
    await syncCourses(userId, t.db);
    const before = await rowsOf(userId);
    const target = before[2];

    const renamed = fakeWith((list) =>
      list.map((c) => (c.moodleId === target.moodleId ? { ...c, name: "A new title, Lecture" } : c)),
    );
    expect(await syncCourses(userId, t.db, renamed)).toEqual({ added: 0, updated: 1, hidden: 0 });

    const after = await rowsOf(userId);
    expect(after[2]).toEqual({ ...target, name: "A new title, Lecture" });
    expect([after[0], after[1], after[3]]).toEqual([before[0], before[1], before[3]]);
  }, SLOW);

  it("shows a course again when it comes back, with the colour it had", async () => {
    const userId = await connectedUser();
    await syncCourses(userId, t.db);
    const first = await rowsOf(userId);
    const dropped = first[0];

    await syncCourses(userId, t.db, fakeWith((list) => list.filter((c) => c.moodleId !== dropped.moodleId)));
    expect((await rowsOf(userId))[0].hidden).toBe(true);

    expect(await syncCourses(userId, t.db)).toEqual({ added: 0, updated: 1, hidden: 0 });
    expect(await rowsOf(userId)).toEqual(first); // same id, same colour, shown again
  }, SLOW);

  it("leaves another user's courses untouched", async () => {
    const userId = await connectedUser();
    const [other] = await t.db.insert(users).values({}).returning();
    const [theirs] = await t.db
      .insert(courses)
      .values([
        // Same Moodle id as one of hers, and one Moodle never returns for her.
        { userId: other.id, moodleId: 3101, name: "Their own title", color: "sky" },
        { userId: other.id, moodleId: 7777, name: "Only theirs", color: "blush" },
      ])
      .returning();
    const before = await rowsOf(other.id);

    expect(await syncCourses(userId, t.db)).toEqual({ added: 4, updated: 0, hidden: 0 });
    await syncCourses(userId, t.db, fakeWith(() => []));

    expect(await rowsOf(other.id)).toEqual(before);
    expect(before[0].id).toBe(theirs.id);
    // Hers: all hidden by the empty answer, none deleted.
    const hers = await rowsOf(userId);
    expect(hers).toHaveLength(4);
    expect(hers.every((row) => row.hidden)).toBe(true);
  }, SLOW);

  it("refuses a user with no Moodle connection and writes nothing", async () => {
    const { user } = await ensureSessionFor(t.db, newToken());
    await expect(syncCourses(user.id, t.db)).rejects.toBeInstanceOf(NotConnected);
    expect(await t.db.select().from(courses)).toHaveLength(0);
  }, SLOW);

  it("writes nothing when Moodle cannot be read", async () => {
    const userId = await connectedUser();
    await syncCourses(userId, t.db);
    const before = await rowsOf(userId);
    const broken: SyncCoursesDeps = {
      getCourses: async () => {
        throw new Error("Moodle is down");
      },
    };
    await expect(syncCourses(userId, t.db, broken)).rejects.toThrow("Moodle is down");
    expect(await rowsOf(userId)).toEqual(before);
  }, SLOW);
});

describe("syncCourses: a course seeded before she connected (M3-57)", () => {
  it("takes the seeded row over by its code: same row, the real id, no second row", async () => {
    const userId = await connectedUser();
    const made = { ...madeUp(5501), code: "TST-E0001", name: "Made-up course, real name" };
    const [seeded] = await t.db
      .insert(courses)
      .values({ userId, moodleId: -12345, code: "tst-e0001", name: "Made-up course", color: "sky" })
      .returning();
    const deps = fakeWith((list) => [...list, made]);
    const result = await syncCourses(userId, t.db, deps);
    expect(result.updated).toBe(1);
    const rows = await rowsOf(userId);
    const mine = rows.filter((r) => r.code === "TST-E0001");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: seeded.id, moodleId: 5501, name: "Made-up course, real name", color: "sky", hidden: false });
    // A second run changes nothing.
    expect((await syncCourses(userId, t.db, deps)).updated).toBe(0);
  }, SLOW);
});

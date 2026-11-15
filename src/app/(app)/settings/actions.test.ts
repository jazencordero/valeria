// @vitest-environment node
import { eq, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, newToken } from "@/server/auth/session";
import { seal } from "@/server/crypto/seal";
import { schema } from "@/server/db/client";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { calendarFeeds, events, pushSubscriptions, reminderLog } from "@/server/db/schema/calendar";
import { courseFiles, courses, filePages } from "@/server/db/schema/courses";
import { gradeItems } from "@/server/db/schema/grades";
import { highlights, lectureConcepts, lectureContent, lectures, notes } from "@/server/db/schema/learn";
import { moodleConnections } from "@/server/db/schema/moodle";
import {
  cardConcepts,
  cards,
  cardStates,
  concepts,
  exams,
  reviews,
  studySessions,
} from "@/server/db/schema/study";
import { aiCalls, jobs, usageEvents } from "@/server/db/schema/system";
import { filesSwitchOn } from "@/server/ai/consent";
import { confirmCodes, identities, users } from "@/server/db/schema/users";
import { assignments, chatMessages, chats, drafts, submissions } from "@/server/db/schema/work";
import { DELETE_PHRASE, deleteAccountFor, disconnectFor, matchesDeletePhrase, setUseFilesFor } from "./actions";

// Made-up values for tests only.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const FAKE_KEY = "test-only-moodle-key-0000";
const SITE = "https://mycourses.aalto.fi";

// Each test seeds two users across the whole schema; the machine is shared, so be generous.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

let t: TestDb;
beforeEach(async () => {
  vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
  t = await createTestDb();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

/** Every table in the schema, and whether it has a `user_id` column (as mergeUsers finds them). */
function schemaTables() {
  return (Object.values(schema) as unknown[])
    .filter((v): v is PgTable => v instanceof PgTable)
    .map((table) => {
      const c = getTableConfig(table);
      return { name: c.name, hasUserId: c.columns.some((col) => col.name === "user_id") };
    });
}

/** Rows with `user_id = userId` in every user-owned table; the users table counts by `id`. */
async function countsFor(userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of schemaTables()) {
    if (!table.hasUserId && table.name !== "users") continue;
    const column = table.name === "users" ? "id" : "user_id";
    const result = (await t.db.execute(
      sql`select count(*)::int as n from ${sql.identifier(table.name)}
          where ${sql.identifier(column)} = ${userId}::uuid`,
    )) as unknown as { rows: { n: number }[] };
    out[table.name] = result.rows[0].n;
  }
  return out;
}

/** Total rows in every table, user-owned or not. */
async function totals(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of schemaTables()) {
    const result = (await t.db.execute(
      sql`select count(*)::int as n from ${sql.identifier(table.name)}`,
    )) as unknown as { rows: { n: number }[] };
    out[table.name] = result.rows[0].n;
  }
  return out;
}

async function newUser(): Promise<string> {
  const { user } = await ensureSessionFor(t.db, newToken());
  return user.id;
}

/**
 * One row in every user-owned table, plus the child tables that hang off them
 * without a `user_id` (file pages, chat messages, card states, ...).
 * `tag` keeps globally unique columns apart between users.
 */
async function seedEverything(userId: string, tag: string) {
  const db = t.db;
  const now = new Date();
  await db.insert(identities).values({ userId, kind: "moodle", siteUrl: SITE, externalId: `ext-${tag}` });
  await db.insert(confirmCodes).values({
    userId,
    purpose: "hand_in",
    payloadHash: `hash-${tag}`,
    expiresAt: now,
  });
  await db.insert(moodleConnections).values({
    userId,
    siteUrl: SITE,
    moodleUserId: 1,
    tokenSealed: seal(FAKE_KEY),
  });
  const [course] = await db
    .insert(courses)
    .values({ userId, moodleId: 10, name: "Test course" })
    .returning();
  const [assignment] = await db
    .insert(assignments)
    .values({ userId, courseId: course.id, moodleId: 20, name: "Test assignment", dueAt: now })
    .returning();
  const [file] = await db
    .insert(courseFiles)
    .values({ userId, courseId: course.id, moodleRef: "f1", name: "slides.pdf", url: "https://example.test/f1" })
    .returning();
  await db.insert(filePages).values({ fileId: file.id, page: 1, text: "Some text" });
  await db.insert(submissions).values({ userId, assignmentId: assignment.id, fileName: "a.pdf", bytes: 1, state: "new" });
  const [chat] = await db.insert(chats).values({ userId, assignmentId: assignment.id }).returning();
  await db.insert(chatMessages).values({ chatId: chat.id, role: "user", parts: [] });
  await db.insert(drafts).values({ userId, assignmentId: assignment.id });
  const [event] = await db
    .insert(events)
    .values({ userId, courseId: course.id, kind: "exam", title: "Exam", startsAt: now, source: "moodle" })
    .returning();
  await db.insert(calendarFeeds).values({ userId, tokenHash: `feed-${tag}` });
  await db.insert(pushSubscriptions).values({
    userId,
    endpoint: `https://push.example.test/${tag}`,
    keys: { p256dh: "x", auth: "y" },
  });
  await db.insert(reminderLog).values({ userId, ref: "r1", kind: "due" });
  await db.insert(gradeItems).values({ userId, courseId: course.id, moodleRef: "g1", name: "Quiz", max: 10 });
  const [exam] = await db
    .insert(exams)
    .values({ userId, courseId: course.id, eventId: event.id, title: "Exam", at: now })
    .returning();
  const [concept] = await db.insert(concepts).values({ userId, examId: exam.id, name: "Concept" }).returning();
  const [card] = await db
    .insert(cards)
    .values({ userId, examId: exam.id, type: "basic", body: {}, origin: "ai", contentHash: "c1" })
    .returning();
  await db.insert(cardConcepts).values({ cardId: card.id, conceptId: concept.id });
  await db.insert(cardStates).values({ cardId: card.id, fsrs: {} });
  const [session] = await db.insert(studySessions).values({ userId, examId: exam.id, mode: "bite" }).returning();
  await db.insert(reviews).values({ userId, cardId: card.id, sessionId: session.id, grade: 3, firstTry: true });
  const [lecture] = await db
    .insert(lectures)
    .values({ userId, courseId: course.id, n: 1, title: "Lecture 1", fileId: file.id })
    .returning();
  await db.insert(lectureContent).values({ lectureId: lecture.id, sourceHash: "s1" });
  await db.insert(lectureConcepts).values({ lectureId: lecture.id, conceptId: concept.id });
  await db.insert(notes).values({ userId, body: "A note", courseId: course.id, lectureId: lecture.id });
  await db.insert(highlights).values({ userId, lectureId: lecture.id, text: "Highlighted" });
  await db.insert(jobs).values({ userId, kind: "sync" });
  await db.insert(aiCalls).values({ userId, provider: "p", model: "m", job: "j", ok: true, ms: 1 });
  await db.insert(usageEvents).values({ userId, kind: "open" });
}

describe("matchesDeletePhrase", () => {
  it("accepts the phrase, ignoring case and surrounding spaces, and nothing else", () => {
    expect(matchesDeletePhrase(DELETE_PHRASE)).toBe(true);
    expect(matchesDeletePhrase(`  ${DELETE_PHRASE.toUpperCase()} `)).toBe(true);
    expect(matchesDeletePhrase("")).toBe(false);
    expect(matchesDeletePhrase("delet")).toBe(false);
    expect(matchesDeletePhrase("delete everything")).toBe(false);
  });
});

describe("disconnectFor", () => {
  it("removes the sealed key and keeps her assignments and courses", async () => {
    const userId = await newUser();
    await seedEverything(userId, "a");
    const before = await countsFor(userId);
    expect(before.moodle_connections).toBe(1);

    await disconnectFor(t.db, userId);

    const after = await countsFor(userId);
    expect(after.moodle_connections).toBe(0);
    expect(after.assignments).toBe(1);
    // Everything except the key stays.
    expect({ ...after, moodle_connections: 1 }).toEqual(before);
  });
});

describe("deleteAccountFor", () => {
  it("removes every row of hers in every user-owned table and leaves another user untouched", async () => {
    const her = await newUser();
    const other = await newUser();
    await seedEverything(her, "her");
    await seedEverything(other, "other");

    const herBefore = await countsFor(her);
    const otherBefore = await countsFor(other);
    const totalsBefore = await totals();
    // The seed reaches every user-owned table the schema has, so a new table
    // without a cascade would show up here.
    const empty = Object.entries(herBefore).filter(([, n]) => n === 0).map(([name]) => name);
    expect(empty, "seedEverything misses these user-owned tables").toEqual([]);

    expect(await deleteAccountFor(t.db, her, DELETE_PHRASE)).toEqual({ ok: true });

    const herAfter = await countsFor(her);
    for (const name of Object.keys(herBefore)) expect(herAfter[name], name).toBe(0);
    expect(await countsFor(other)).toEqual(otherBefore);

    // Child tables without user_id (file pages, chat messages, card states, ...)
    // lose exactly her half. ai_calls keeps its metrics row, with user_id null.
    const totalsAfter = await totals();
    for (const [name, n] of Object.entries(totalsBefore)) {
      const expected = name === "ai_calls" ? n : n / 2;
      expect(totalsAfter[name], name).toBe(expected);
    }
  });

  it("deletes nothing when the typed confirmation is wrong", async () => {
    const her = await newUser();
    await seedEverything(her, "her");
    const before = await totals();

    for (const typed of ["", "delet", "yes", "delete it"]) {
      expect(await deleteAccountFor(t.db, her, typed)).toEqual({ ok: false, reason: "confirmation" });
    }
    expect(await totals()).toEqual(before);
  });
});

describe("setUseFilesFor", () => {
  const settingsOf = async (userId: string) =>
    (await t.db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)))[0].settings;

  it("turns her switch off and on again and keeps every other settings key", async () => {
    const her = await newUser();
    const other = await newUser();
    const before = { syncCursor: { at: 5 }, moodleCalls: { n: 3, day: "2026-11-15" }, ai: { other: "kept" } };
    await t.db.update(users).set({ settings: before }).where(eq(users.id, her));
    expect(filesSwitchOn(await settingsOf(her))).toBe(true);

    await setUseFilesFor(t.db, her, false);
    expect(await settingsOf(her)).toEqual({ ...before, ai: { other: "kept", useFiles: false } });
    expect(filesSwitchOn(await settingsOf(her))).toBe(false);

    await setUseFilesFor(t.db, her, true);
    expect(await settingsOf(her)).toEqual({ ...before, ai: { other: "kept", useFiles: true } });
    expect(filesSwitchOn(await settingsOf(her))).toBe(true);

    // Someone else's settings are not touched.
    expect(await settingsOf(other)).toEqual({});
  });

  it("works from empty settings, and from an `ai` value that is not an object", async () => {
    const her = await newUser();
    await setUseFilesFor(t.db, her, false);
    expect(await settingsOf(her)).toEqual({ ai: { useFiles: false } });

    await t.db.update(users).set({ settings: { ai: "odd", keep: 1 } }).where(eq(users.id, her));
    await setUseFilesFor(t.db, her, false);
    expect(await settingsOf(her)).toEqual({ ai: { useFiles: false }, keep: 1 });
  });
});

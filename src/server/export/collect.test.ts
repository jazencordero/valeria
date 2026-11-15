// @vitest-environment node
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, hashToken, newToken, NotSignedIn } from "@/server/auth/session";
import { schema } from "@/server/db/client";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { calendarFeeds, events, pushSubscriptions, reminderLog } from "@/server/db/schema/calendar";
import { courseFiles, courses, filePages } from "@/server/db/schema/courses";
import { gradeItems } from "@/server/db/schema/grades";
import { highlights, lectureConcepts, lectureContent, lectures, notes, tutorMessages } from "@/server/db/schema/learn";
import { moodleConnections } from "@/server/db/schema/moodle";
import {
  cardConcepts,
  cards,
  cardStates,
  concepts,
  examDocuments,
  exams,
  reviews,
  studySessions,
} from "@/server/db/schema/study";
import { aiCache, aiCalls, jobs, providerCooldowns, usageEvents } from "@/server/db/schema/system";
import { confirmCodes, identities } from "@/server/db/schema/users";
import { assignments, chatMessages, chats, drafts, submissions } from "@/server/db/schema/work";
import { collectExport, EXPORT_PLAN, GLOBAL_TABLES, NEVER_EXPORT, tableName } from "./collect";

// The route test swaps in the test database and a fake signed-in user.
const hoisted = vi.hoisted(() => ({ db: undefined as unknown, currentUser: vi.fn() }));
vi.mock("@/server/db/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db/client")>();
  const db = new Proxy({}, {
    get(_target, prop) {
      const value: unknown = Reflect.get(hoisted.db as object, prop);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(hoisted.db) : value;
    },
  });
  return { ...real, db };
});
vi.mock("@/server/auth/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/auth/session")>();
  return { ...real, currentUser: hoisted.currentUser };
});

// Each test seeds two users across the whole schema; the machine is shared, so be generous.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const SITE = "https://mycourses.example.test";

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  hoisted.db = t.db;
  hoisted.currentUser.mockReset();
});
afterEach(async () => {
  await t.close();
});

/* ------------------------------------------------------------------------- */
/* What the schema says is user-owned (the way mergeUsers finds it).          */
/* ------------------------------------------------------------------------- */

type SchemaTable = { name: string; hasUserId: boolean; references: string[] };

function schemaTables(): SchemaTable[] {
  return (Object.values(schema) as unknown[])
    .filter((v): v is PgTable => v instanceof PgTable)
    .map((table) => {
      const c = getTableConfig(table);
      return {
        name: c.name,
        hasUserId: c.columns.some((col) => col.name === "user_id"),
        references: c.foreignKeys.map((fk) => getTableConfig(fk.reference().foreignTable).name),
      };
    });
}

/** `users`, every table with `user_id`, and every table that reaches one of those by foreign key. */
function userOwnedTables(): string[] {
  const tables = schemaTables();
  const owned = new Set(tables.filter((x) => x.hasUserId || x.name === "users").map((x) => x.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const x of tables) {
      if (!owned.has(x.name) && x.references.some((r) => owned.has(r))) {
        owned.add(x.name);
        grew = true;
      }
    }
  }
  return [...owned].sort();
}

/* ------------------------------------------------------------------------- */
/* Seed: one row in every user-owned table, with secrets we can look for.    */
/* ------------------------------------------------------------------------- */

const secretsFor = (tag: string) => ({
  sealed: `SECRET-sealed-${tag}`,
  privateSealed: `SECRET-private-sealed-${tag}`,
  feedHash: `SECRET-feed-hash-${tag}`,
  payloadHash: `SECRET-payload-hash-${tag}`,
  pushEndpoint: `https://push.example.test/SECRET-${tag}`,
  pushAuth: `SECRET-push-auth-${tag}`,
});

async function newUser(): Promise<{ id: string; token: string }> {
  const token = newToken();
  const { user } = await ensureSessionFor(t.db, token);
  return { id: user.id, token };
}

async function seedEverything(userId: string, tag: string) {
  const db = t.db;
  const now = new Date();
  const secret = secretsFor(tag);
  await db.insert(identities).values({ userId, kind: "moodle", siteUrl: SITE, externalId: `ext-${tag}` });
  await db.insert(confirmCodes).values({ userId, purpose: "hand_in", payloadHash: secret.payloadHash, expiresAt: now });
  await db.insert(moodleConnections).values({
    userId,
    siteUrl: SITE,
    moodleUserId: 1,
    tokenSealed: secret.sealed,
    privateTokenSealed: secret.privateSealed,
  });
  const [course] = await db.insert(courses).values({ userId, moodleId: 10, name: `Course ${tag}` }).returning();
  const [assignment] = await db
    .insert(assignments)
    .values({ userId, courseId: course.id, moodleId: 20, name: `Assignment ${tag}`, dueAt: now })
    .returning();
  const [file] = await db
    .insert(courseFiles)
    .values({ userId, courseId: course.id, moodleRef: "f1", name: "slides.pdf", url: "https://example.test/f1" })
    .returning();
  await db.insert(filePages).values({ fileId: file.id, page: 1, text: `Page text ${tag}` });
  await db.insert(submissions).values({ userId, assignmentId: assignment.id, fileName: "a.pdf", bytes: 1, state: "new" });
  const [chat] = await db.insert(chats).values({ userId, assignmentId: assignment.id }).returning();
  await db.insert(chatMessages).values({ chatId: chat.id, role: "user", parts: [{ type: "text", text: `Hi ${tag}` }] });
  await db.insert(drafts).values({ userId, assignmentId: assignment.id, contentMd: `Draft ${tag}` });
  const [event] = await db
    .insert(events)
    .values({ userId, courseId: course.id, kind: "exam", title: "Exam", startsAt: now, source: "moodle" })
    .returning();
  await db.insert(calendarFeeds).values({ userId, tokenHash: secret.feedHash });
  await db.insert(pushSubscriptions).values({
    userId,
    endpoint: secret.pushEndpoint,
    keys: { p256dh: `p256-${tag}`, auth: secret.pushAuth },
  });
  await db.insert(reminderLog).values({ userId, ref: "r1", kind: "due" });
  await db.insert(gradeItems).values({ userId, courseId: course.id, moodleRef: "g1", name: "Quiz", max: 10 });
  const [exam] = await db
    .insert(exams)
    .values({ userId, courseId: course.id, eventId: event.id, title: "Exam", at: now })
    .returning();
  await db.insert(examDocuments).values({ userId, examId: exam.id, slug: "plan", title: "Plan", bodyMd: "# Plan" });
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
  await db.insert(lectureContent).values({ lectureId: lecture.id, sourceHash: `s-${tag}` });
  await db.insert(lectureConcepts).values({ lectureId: lecture.id, conceptId: concept.id });
  const [note] = await db.insert(notes).values({ userId, body: `Note ${tag}`, courseId: course.id, lectureId: lecture.id }).returning();
  await db.insert(tutorMessages).values({
    userId,
    noteId: note.id,
    anchorKind: "lecture",
    anchorId: lecture.id,
    role: "assistant",
    body: `Tutor answer ${tag}`,
    model: "groq:openai/gpt-oss-120b",
    tokensIn: 10,
    tokensOut: 5,
  });
  await db.insert(highlights).values({ userId, lectureId: lecture.id, text: "Highlighted" });
  await db.insert(jobs).values({ userId, kind: "sync" });
  await db.insert(aiCalls).values({ userId, provider: "p", model: "m", job: "j", ok: true, ms: 1 });
  await db.insert(usageEvents).values({ userId, kind: "open" });
  // Global rows, so a join mistake could leak them too.
  await db.insert(aiCache).values({ hash: `cache-${tag}`, job: "j", model: "m", output: { tag } });
  await db.insert(providerCooldowns).values({ provider: `provider-${tag}`, until: now });
}

/* ------------------------------------------------------------------------- */

describe("EXPORT_PLAN", () => {
  it("has exactly one entry for every table in the schema", () => {
    const planned = [...EXPORT_PLAN.map((e) => tableName(e.table)), ...GLOBAL_TABLES.map((g) => tableName(g.table))];
    expect(new Set(planned).size, "a table is listed twice").toBe(planned.length);
    expect([...planned].sort()).toEqual(schemaTables().map((x) => x.name).sort());
  });

  it("covers or explicitly excludes every user-owned table, and none of them is filed as global", () => {
    const inPlan = new Set(EXPORT_PLAN.map((e) => tableName(e.table)));
    const missing = userOwnedTables().filter((name) => !inPlan.has(name));
    expect(missing, "user-owned tables with no export entry").toEqual([]);
    const global = GLOBAL_TABLES.map((g) => tableName(g.table));
    expect(global.filter((name) => userOwnedTables().includes(name))).toEqual([]);
  });

  it("gives every exclusion a reason", () => {
    for (const e of EXPORT_PLAN) if (e.kind === "exclude") expect(e.reason.length, tableName(e.table)).toBeGreaterThan(10);
    for (const g of GLOBAL_TABLES) expect(g.reason.length, tableName(g.table)).toBeGreaterThan(10);
  });
});

describe("collectExport", () => {
  it("returns her rows in every exported table and nothing of another user's", async () => {
    const her = await newUser();
    const other = await newUser();
    await seedEverything(her.id, "her");
    await seedEverything(other.id, "other");

    const now = new Date("2026-11-14T12:00:00Z");
    const file = await collectExport(t.db, her.id, now);
    expect(file.version).toBe(1);
    expect(file.exportedAt).toBe("2026-11-14T12:00:00.000Z");
    expect(file.userId).toBe(her.id);

    const exported = EXPORT_PLAN.filter((e) => e.kind !== "exclude").map((e) => tableName(e.table));
    const excluded = EXPORT_PLAN.filter((e) => e.kind === "exclude").map((e) => tableName(e.table));
    expect(Object.keys(file.tables).sort()).toEqual([...exported].sort());
    expect(Object.keys(file.excluded).sort()).toEqual([...excluded].sort());

    // The seed puts exactly one row per user in each table.
    for (const name of exported) expect(file.tables[name], name).toHaveLength(1);
    expect(file.tables.users[0].id).toBe(her.id);
    for (const name of exported) {
      const row = file.tables[name][0];
      if ("userId" in row) expect(row.userId, name).toBe(her.id);
    }

    const json = JSON.stringify(file);
    expect(json).not.toContain(other.id);
    expect(json).not.toContain("other");
    expect(json).toContain("Note her");
    expect(json).toContain("Page text her");
    // Her tutor chat is in it (M2-28).
    expect(file.tables.tutor_messages[0]).toMatchObject({ body: "Tutor answer her", role: "assistant", model: "groq:openai/gpt-oss-120b", tokensOut: 5 });
    expect(JSON.parse(json)).toEqual(file);
  });

  it("never writes a sealed key, token hash or other secret", async () => {
    const her = await newUser();
    await seedEverything(her.id, "her");
    const file = await collectExport(t.db, her.id);
    const json = JSON.stringify(file);

    for (const column of NEVER_EXPORT) expect(json).not.toContain(column);
    for (const key of ["tokenSealed", "privateTokenSealed", "tokenHash", "payloadHash"]) {
      expect(json).not.toContain(`"${key}"`);
    }
    for (const value of Object.values(secretsFor("her"))) expect(json).not.toContain(value);
    expect(json).not.toContain(hashToken(her.token));
    expect(json).not.toContain("SECRET");

    // The useful metadata is still there.
    expect(file.tables.moodle_connections[0].siteUrl).toBe(SITE);
    expect(file.tables.sessions).toHaveLength(1);
    expect(file.tables.calendar_feeds).toHaveLength(1);
  });
});

describe("GET /api/export", () => {
  it("answers 401 with no session", async () => {
    hoisted.currentUser.mockRejectedValue(new NotSignedIn());
    const { GET } = await import("@/app/api/export/route");
    const res = await GET();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "not_signed_in" });
  });

  it("sends her export as a dated JSON attachment that is never cached", async () => {
    const her = await newUser();
    await seedEverything(her.id, "her");
    hoisted.currentUser.mockResolvedValue({ id: her.id });
    const { GET } = await import("@/app/api/export/route");

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="ready-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const text = await res.text();
    expect(text).not.toContain("token_sealed");
    expect(text).not.toContain("SECRET");
    const body = JSON.parse(text);
    expect(body.userId).toBe(her.id);
    expect(body.tables.notes[0].body).toBe("Note her");
  });
});

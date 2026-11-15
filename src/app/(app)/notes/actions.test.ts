// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { exams, studySessions } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { getNote } from "@/server/notes/store";

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
      return { id: holder.userId };
    },
  };
});
vi.mock("next/cache", () => ({ refresh: vi.fn() }));

const { notepadContext, saveNotepad } = await import("./actions");

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

let t: TestDb;
let her: string;
let other: string;
let examId: string;
let sessionId: string;
let theirSessionId: string;

async function makeUser(): Promise<string> {
  const [u] = await t.db.insert(users).values({}).returning();
  return u.id;
}

beforeEach(async () => {
  t = await createTestDb();
  holder.db = t.db;
  her = await makeUser();
  other = await makeUser();
  holder.userId = her;
  const [c] = await t.db.insert(courses).values({ userId: her, moodleId: 1, name: "Strategic IT Management" }).returning();
  const [e] = await t.db.insert(exams).values({ userId: her, courseId: c.id, title: "Final", at: new Date(Date.now() + 6 * 86_400_000) }).returning();
  examId = e.id;
  const [s] = await t.db.insert(studySessions).values({ userId: her, examId, mode: "bite" }).returning();
  sessionId = s.id;
  const [oc] = await t.db.insert(courses).values({ userId: other, moodleId: 1, name: "Their course" }).returning();
  const [oe] = await t.db.insert(exams).values({ userId: other, courseId: oc.id, title: "Theirs", at: new Date() }).returning();
  const [os] = await t.db.insert(studySessions).values({ userId: other, examId: oe.id, mode: "bite" }).returning();
  theirSessionId = os.id;
});

afterEach(async () => {
  holder.userId = null;
  await t.close();
});

describe("a note made over a study session (Ask about this card, M2-28)", () => {
  it("the chip names the session's exam, not General", async () => {
    expect(await notepadContext(`/study/${sessionId}`)).toEqual({ ok: true, label: "Exam · Strategic IT Management" });
    expect(await notepadContext(`/study/${sessionId}/?x=1#y`)).toEqual({ ok: true, label: "Exam · Strategic IT Management" });
  });

  it("the note is stored on the session's exam", async () => {
    const r = await saveNotepad({ path: `/study/${sessionId}`, title: "", body: "Why?", quote: "Q?\n\nAnswer: A.", highlighted: false });
    expect(r.ok).toBe(true);
    const id = r.ok ? r.id : null;
    const stored = await getNote(her, id!, t.db);
    expect(stored?.attach).toEqual({ kind: "exam", id: examId });
    expect(stored?.quote).toBe("Q?\n\nAnswer: A.");
  });

  it("someone else's session (or one that does not exist) is General: nothing of theirs is read or linked", async () => {
    expect(await notepadContext(`/study/${theirSessionId}`)).toEqual({ ok: true, label: "General" });
    expect(await notepadContext("/study/00000000-0000-4000-8000-000000000000")).toEqual({ ok: true, label: "General" });
    expect(await notepadContext("/study/new?exam=x")).toEqual({ ok: true, label: "General" });
    const r = await saveNotepad({ path: `/study/${theirSessionId}`, title: "", body: "Mine", quote: null, highlighted: false });
    const stored = await getNote(her, r.ok ? r.id! : "", t.db);
    expect(stored?.attach).toEqual({ kind: "general", id: null });
  });

  it("other pages attach as before", async () => {
    expect(await notepadContext(`/exams/${examId}`)).toEqual({ ok: true, label: "Exam · Strategic IT Management" });
    expect(await notepadContext("/home")).toEqual({ ok: true, label: "General" });
  });
});

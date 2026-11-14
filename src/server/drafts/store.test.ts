// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { courses } from "@/server/db/schema/courses";
import { users } from "@/server/db/schema/users";
import { assignments, drafts } from "@/server/db/schema/work";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { DRAFT_MAX_CHARS, DRAFT_TITLE_MAX, DraftNotFound, getDraft, saveDraft } from "./store";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

let refs = 0;

async function seed(name: string) {
  const [user] = await t.db.insert(users).values({ displayName: name }).returning();
  const [course] = await t.db
    .insert(courses)
    .values({ userId: user.id, moodleId: ++refs, name: "Plant Biology", aiPolicy: "allowed" })
    .returning();
  const [assignment] = await t.db
    .insert(assignments)
    .values({ userId: user.id, courseId: course.id, moodleId: ++refs, name: "Essay 1" })
    .returning();
  return { user, course, assignment };
}

const TEXT = "## Summary\n\nOsmosis moves water.\n\n## Conclusion\n\n[Your conclusion goes here.]";

describe("saveDraft and getDraft", () => {
  it("stores a draft and reads it back", async () => {
    const { user, assignment } = await seed("Student A");
    expect(await getDraft(user.id, assignment.id, t.db)).toBeNull();

    const saved = await saveDraft(user.id, assignment.id, { title: "  Essay 1:\n Osmosis ", contentMd: TEXT }, t.db);
    expect(saved).toMatchObject({
      userId: user.id,
      assignmentId: assignment.id,
      title: "Essay 1: Osmosis",
      contentMd: TEXT,
    });

    expect(await getDraft(user.id, assignment.id, t.db)).toEqual(saved);
  });

  it("keeps one draft per assignment: the latest wins and the id stays", async () => {
    const { user, assignment } = await seed("Student A");
    const first = await saveDraft(user.id, assignment.id, { title: "First", contentMd: "one" }, t.db);
    const second = await saveDraft(user.id, assignment.id, { title: "Second", contentMd: "two" }, t.db);

    expect(second.id).toBe(first.id);
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    expect(await t.db.select().from(drafts)).toHaveLength(1);
    expect(await getDraft(user.id, assignment.id, t.db)).toMatchObject({ title: "Second", contentMd: "two" });
  });

  it("refuses another user's assignment, an unknown one and a malformed id, and stores nothing", async () => {
    const a = await seed("Student A");
    const b = await seed("Student B");
    await saveDraft(a.user.id, a.assignment.id, { title: "Hers", contentMd: "her text" }, t.db);

    const input = { title: "Mine now", contentMd: "overwritten" };
    await expect(saveDraft(b.user.id, a.assignment.id, input, t.db)).rejects.toBeInstanceOf(DraftNotFound);
    await expect(
      saveDraft(a.user.id, "00000000-0000-4000-8000-000000000000", input, t.db),
    ).rejects.toBeInstanceOf(DraftNotFound);
    await expect(saveDraft(a.user.id, "not-a-uuid", input, t.db)).rejects.toBeInstanceOf(DraftNotFound);

    await expect(getDraft(b.user.id, a.assignment.id, t.db)).rejects.toBeInstanceOf(DraftNotFound);
    await expect(getDraft(a.user.id, "not-a-uuid", t.db)).rejects.toBeInstanceOf(DraftNotFound);

    // Hers is untouched, and the other student has none.
    expect(await t.db.select().from(drafts)).toHaveLength(1);
    expect(await getDraft(a.user.id, a.assignment.id, t.db)).toMatchObject({ title: "Hers", contentMd: "her text" });
    expect(await getDraft(b.user.id, b.assignment.id, t.db)).toBeNull();
  });

  it("refuses an empty title or text and a text over the limit; cuts a long title", async () => {
    const { user, assignment } = await seed("Student A");
    await expect(saveDraft(user.id, assignment.id, { title: " ", contentMd: "x" }, t.db)).rejects.toThrow();
    await expect(saveDraft(user.id, assignment.id, { title: "T", contentMd: "  " }, t.db)).rejects.toThrow();
    await expect(
      saveDraft(user.id, assignment.id, { title: "T", contentMd: "x".repeat(DRAFT_MAX_CHARS + 1) }, t.db),
    ).rejects.toThrow();
    expect(await t.db.select().from(drafts)).toHaveLength(0);

    const saved = await saveDraft(user.id, assignment.id, { title: "t".repeat(500), contentMd: "x" }, t.db);
    expect(saved.title).toHaveLength(DRAFT_TITLE_MAX);
  });

  it("goes when the assignment goes", async () => {
    const { user, assignment } = await seed("Student A");
    await saveDraft(user.id, assignment.id, { title: "T", contentMd: "x" }, t.db);
    await t.db.delete(assignments);
    expect(await t.db.select().from(drafts)).toHaveLength(0);
  });
});

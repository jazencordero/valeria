// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { users } from "@/server/db/schema/users";
import { assignments, chatMessages, chats } from "@/server/db/schema/work";
import { appendMessage, ChatNotFound, getOrCreateChat, listMessages, type ChatPart } from "./store";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

async function seedUser(name: string, moodleId: number) {
  const [user] = await t.db.insert(users).values({ displayName: name }).returning();
  const [course] = await t.db
    .insert(courses)
    .values({ userId: user.id, moodleId, name: "Test Course", color: "mint" })
    .returning();
  const [assignment] = await t.db
    .insert(assignments)
    .values({ userId: user.id, courseId: course.id, moodleId: moodleId + 1, name: "Essay 1" })
    .returning();
  return { user, assignment };
}

describe("getOrCreateChat", () => {
  it("creates one chat per assignment and returns it again", async () => {
    const { user, assignment } = await seedUser("Student A", 100);
    const first = await getOrCreateChat(user.id, assignment.id, t.db);
    const second = await getOrCreateChat(user.id, assignment.id, t.db);

    expect(second.id).toBe(first.id);
    expect(first.userId).toBe(user.id);
    expect(first.assignmentId).toBe(assignment.id);
    expect(await t.db.select().from(chats)).toHaveLength(1);
  });

  it("refuses an assignment the caller does not own", async () => {
    const a = await seedUser("Student A", 100);
    const b = await seedUser("Student B", 200);

    await expect(getOrCreateChat(b.user.id, a.assignment.id, t.db)).rejects.toBeInstanceOf(
      ChatNotFound,
    );
    expect(await t.db.select().from(chats)).toHaveLength(0);
  });

  it("refuses an unknown or malformed assignment id", async () => {
    const { user } = await seedUser("Student A", 100);
    await expect(
      getOrCreateChat(user.id, "00000000-0000-4000-8000-000000000000", t.db),
    ).rejects.toBeInstanceOf(ChatNotFound);
    await expect(getOrCreateChat(user.id, "not-a-uuid", t.db)).rejects.toBeInstanceOf(
      ChatNotFound,
    );
  });
});

describe("appendMessage and listMessages", () => {
  it("returns messages in the order they were appended, with every part type", async () => {
    const { user, assignment } = await seedUser("Student A", 100);
    const chat = await getOrCreateChat(user.id, assignment.id, t.db);

    const sent: { role: "user" | "assistant"; parts: ChatPart[] }[] = [
      { role: "user", parts: [{ type: "text", text: "Where do I start?" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Start with the brief." },
          { type: "source", label: "Assignment brief" },
        ],
      },
      { role: "assistant", parts: [{ type: "draft", draftId: "draft-1" }] },
      { role: "assistant", parts: [{ type: "receipt", at: "2026-11-14T10:00:00.000Z" }] },
    ];
    for (let i = 0; i < 20; i++) {
      sent.push({ role: i % 2 ? "assistant" : "user", parts: [{ type: "text", text: `n${i}` }] });
    }

    for (const m of sent) await appendMessage(user.id, chat.id, m.role, m.parts, t.db);

    const got = await listMessages(user.id, chat.id, t.db);
    expect(got.map((m) => ({ role: m.role, parts: m.parts }))).toEqual(sent);
    for (let i = 1; i < got.length; i++) {
      expect(got[i].createdAt.getTime()).toBeGreaterThanOrEqual(got[i - 1].createdAt.getTime());
    }
  });

  it("starts empty", async () => {
    const { user, assignment } = await seedUser("Student A", 100);
    const chat = await getOrCreateChat(user.id, assignment.id, t.db);
    expect(await listMessages(user.id, chat.id, t.db)).toEqual([]);
  });

  it("does not let another user read the chat", async () => {
    const a = await seedUser("Student A", 100);
    const b = await seedUser("Student B", 200);
    const chat = await getOrCreateChat(a.user.id, a.assignment.id, t.db);
    await appendMessage(a.user.id, chat.id, "user", [{ type: "text", text: "private" }], t.db);

    await expect(listMessages(b.user.id, chat.id, t.db)).rejects.toBeInstanceOf(ChatNotFound);
  });

  it("does not let another user append to the chat", async () => {
    const a = await seedUser("Student A", 100);
    const b = await seedUser("Student B", 200);
    const chat = await getOrCreateChat(a.user.id, a.assignment.id, t.db);

    await expect(
      appendMessage(b.user.id, chat.id, "user", [{ type: "text", text: "sneaky" }], t.db),
    ).rejects.toBeInstanceOf(ChatNotFound);
    expect(await t.db.select().from(chatMessages)).toHaveLength(0);
    expect(await listMessages(a.user.id, chat.id, t.db)).toEqual([]);
  });

  it("refuses an unknown or malformed chat id", async () => {
    const { user } = await seedUser("Student A", 100);
    await expect(
      listMessages(user.id, "00000000-0000-4000-8000-000000000000", t.db),
    ).rejects.toBeInstanceOf(ChatNotFound);
    await expect(
      appendMessage(user.id, "nope", "user", [{ type: "text", text: "x" }], t.db),
    ).rejects.toBeInstanceOf(ChatNotFound);
  });

  it("rejects malformed parts and roles without writing", async () => {
    const { user, assignment } = await seedUser("Student A", 100);
    const chat = await getOrCreateChat(user.id, assignment.id, t.db);

    await expect(appendMessage(user.id, chat.id, "user", [], t.db)).rejects.toThrow();
    await expect(
      appendMessage(user.id, chat.id, "user", [{ type: "image" } as unknown as ChatPart], t.db),
    ).rejects.toThrow();
    await expect(
      appendMessage(user.id, chat.id, "system" as "user", [{ type: "text", text: "x" }], t.db),
    ).rejects.toThrow();
    expect(await t.db.select().from(chatMessages)).toHaveLength(0);
  });
});

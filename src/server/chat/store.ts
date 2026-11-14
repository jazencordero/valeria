/*
 * Conversation storage for an assignment: one chat per assignment, messages
 * appended in order and never edited or deleted.
 *
 * Every call takes the caller's `userId` and checks ownership. A chat or
 * assignment that does not exist and one that belongs to someone else both
 * throw the same `ChatNotFound`, so a caller cannot probe for other users' ids.
 *
 * Like `src/server/auth/session.ts`, the database is the last argument and
 * defaults to the shared client, so tests pass a fresh PGlite.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb, type Db } from "@/server/db/client";
import { assignments, chatMessages, chats } from "@/server/db/schema/work";

export const CHAT_ROLES = ["user", "assistant"] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

const partSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("source"), label: z.string().min(1) }),
  z.object({ type: z.literal("draft"), draftId: z.string().min(1) }),
  z.object({ type: z.literal("receipt"), at: z.string().min(1) }),
]);
const partsSchema = z.array(partSchema).min(1);

export type ChatPart = z.infer<typeof partSchema>;

export type Chat = typeof chats.$inferSelect;

export type ChatMessage = {
  id: string;
  chatId: string;
  createdAt: Date;
  role: ChatRole;
  parts: ChatPart[];
};

/** The chat or assignment does not exist, or belongs to another user. */
export class ChatNotFound extends Error {
  constructor() {
    super("Chat not found.");
    this.name = "ChatNotFound";
  }
}

async function ownedChat(database: Db, userId: string, chatId: string): Promise<Chat> {
  if (!z.uuid().safeParse(chatId).success) throw new ChatNotFound();
  const [chat] = await database
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);
  if (!chat) throw new ChatNotFound();
  return chat;
}

/** The one chat for this assignment, created on first call. */
export async function getOrCreateChat(
  userId: string,
  assignmentId: string,
  database: Db = defaultDb,
): Promise<Chat> {
  if (!z.uuid().safeParse(assignmentId).success) throw new ChatNotFound();
  const [assignment] = await database
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.id, assignmentId), eq(assignments.userId, userId)))
    .limit(1);
  if (!assignment) throw new ChatNotFound();

  await database
    .insert(chats)
    .values({ userId, assignmentId })
    .onConflictDoNothing({ target: chats.assignmentId });

  const [chat] = await database
    .select()
    .from(chats)
    .where(and(eq(chats.assignmentId, assignmentId), eq(chats.userId, userId)))
    .limit(1);
  if (!chat) throw new ChatNotFound();
  return chat;
}

/** Every message in the chat, oldest first. */
export async function listMessages(
  userId: string,
  chatId: string,
  database: Db = defaultDb,
): Promise<ChatMessage[]> {
  await ownedChat(database, userId, chatId);
  const rows = await database
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(asc(chatMessages.createdAt));
  return rows.map((row) => ({
    id: row.id,
    chatId: row.chatId,
    createdAt: row.createdAt,
    role: row.role as ChatRole,
    parts: row.parts as ChatPart[],
  }));
}

/** Adds one message at the end of the chat. */
export async function appendMessage(
  userId: string,
  chatId: string,
  role: ChatRole,
  parts: ChatPart[],
  database: Db = defaultDb,
): Promise<ChatMessage> {
  if (!CHAT_ROLES.includes(role)) throw new TypeError(`Unknown chat role: ${String(role)}`);
  const checked = partsSchema.parse(parts);
  await ownedChat(database, userId, chatId);

  // Strictly later than the chat's last message, so order by created_at is
  // total even when two messages land in the same microsecond.
  const [row] = await database
    .insert(chatMessages)
    .values({
      chatId,
      role,
      parts: checked,
      createdAt: sql`greatest(clock_timestamp(), coalesce((select max(${chatMessages.createdAt}) from ${chatMessages} where ${chatMessages.chatId} = ${chatId}) + interval '1 microsecond', '-infinity'::timestamptz))`,
    })
    .returning();
  return {
    id: row.id,
    chatId: row.chatId,
    createdAt: row.createdAt,
    role: row.role as ChatRole,
    parts: row.parts as ChatPart[],
  };
}

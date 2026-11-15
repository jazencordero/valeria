/*
 * M2-28: tutor chats in the database (`tutor_messages`).
 *
 *   const key = noteKey(note) ?? anchorKey(context.anchor);
 *   const chat = await loadChat(userId, key);            // reopening a note shows its chat
 *   const history = await recentTurns(userId, key);      // what the model gets, last 8 messages
 *   await storeTurn({ userId, key, question, answer });  // after the answer streamed
 *
 * A chat belongs to the note it sits under when there is one, otherwise to its anchor (the
 * lecture, exam or card, or "general") for that user. Every read and write is scoped to the
 * user; a note or answer id that is not hers reads as missing.
 *
 * "Go deeper" stores a second answer to the same question (`reply_to`); the chat shows both,
 * and the model's history uses the newest answer of each question.
 *
 * Nothing here logs anything.
 */
import { and, asc, desc, eq, isNull, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { notes, tutorMessages } from "@/server/db/schema/learn";
import { HISTORY_MAX_CHARS, HISTORY_MESSAGES, type TutorAnchor } from "./context";

/** The chat: under a note, or (no note) under an anchor. */
export type ChatKey = { noteId: string; anchor: TutorAnchor } | { noteId: null; anchor: TutorAnchor };

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** "provider:model" for answers, null for her messages. */
  model: string | null;
  /** The question an answer belongs to. */
  replyTo: string | null;
  /** The passage her message was about, if any. */
  quote: string | null;
  createdAt: Date;
};

export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** True when counted as characters / 4 because the provider gave no usage. */
  estimated: boolean;
};

const isUuid = (v: string) => z.uuid().safeParse(v).success;

/** Rows of this chat, for `userId`. */
function inChat(userId: string, key: ChatKey): SQL {
  if (key.noteId) return and(eq(tutorMessages.userId, userId), eq(tutorMessages.noteId, key.noteId))!;
  return and(
    eq(tutorMessages.userId, userId),
    isNull(tutorMessages.noteId),
    eq(tutorMessages.anchorKind, key.anchor.kind),
    key.anchor.id === null ? isNull(tutorMessages.anchorId) : eq(tutorMessages.anchorId, key.anchor.id),
  )!;
}

/** Her note with that id (id, quote and body), or null when it is not hers or gone. */
export async function ownNote(userId: string, noteId: string, database: Db = defaultDb) {
  if (!isUuid(userId) || !isUuid(noteId)) return null;
  const [row] = await database
    .select({ id: notes.id, quote: notes.quote, body: notes.body, lectureId: notes.lectureId })
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
    .limit(1);
  return row ?? null;
}

function toStored(r: typeof tutorMessages.$inferSelect): StoredMessage {
  return { id: r.id, role: r.role, text: r.body, model: r.model, replyTo: r.replyTo, quote: r.quote, createdAt: r.createdAt };
}

/** Questions in the order she asked them, each followed by its answers (a deeper one last). */
function threadOrder(rows: StoredMessage[]): StoredMessage[] {
  const byTime = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const answers = new Map<string, StoredMessage[]>();
  const loose: StoredMessage[] = [];
  const questions = new Set(byTime.filter((m) => m.role === "user").map((m) => m.id));
  for (const m of byTime) {
    if (m.role !== "assistant") continue;
    if (m.replyTo && questions.has(m.replyTo)) answers.set(m.replyTo, [...(answers.get(m.replyTo) ?? []), m]);
    else loose.push(m);
  }
  const out: StoredMessage[] = [];
  for (const m of byTime) {
    if (m.role === "user") out.push(m, ...(answers.get(m.id) ?? []));
    else if (loose.includes(m)) out.push(m);
  }
  return out;
}

/** The whole chat, oldest first (questions each followed by their answers). */
export async function loadChat(userId: string, key: ChatKey, database: Db = defaultDb): Promise<StoredMessage[]> {
  if (!isUuid(userId)) return [];
  const rows = await database.select().from(tutorMessages).where(inChat(userId, key)).orderBy(asc(tutorMessages.createdAt));
  return threadOrder(rows.map(toStored));
}

/** True when the chat already has an answer (the "say it once" line was said). */
export async function hasAnswer(userId: string, key: ChatKey, database: Db = defaultDb): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const [row] = await database
    .select({ id: tutorMessages.id })
    .from(tutorMessages)
    .where(and(inChat(userId, key), eq(tutorMessages.role, "assistant")))
    .limit(1);
  return Boolean(row);
}

/**
 * The model's history: the last `HISTORY_MESSAGES` messages of the chat, from storage (never
 * from the client), each question with only its newest answer, starting with one of hers, and
 * no more than HISTORY_MAX_CHARS in all (the newest that fit).
 * `before`: only what was asked before this time (for "Go deeper" on an older question).
 */
export async function recentTurns(
  userId: string,
  key: ChatKey,
  options: { before?: Date; limit?: number } = {},
  database: Db = defaultDb,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  if (!isUuid(userId)) return [];
  const limit = options.limit ?? HISTORY_MESSAGES;
  // Enough rows for `limit` messages even with a few deeper answers in between.
  const rows = await database
    .select()
    .from(tutorMessages)
    .where(options.before ? and(inChat(userId, key), lt(tutorMessages.createdAt, options.before)) : inChat(userId, key))
    .orderBy(desc(tutorMessages.createdAt))
    .limit(limit * 3);
  const ordered = threadOrder(rows.map(toStored));
  // Keep the newest answer of each question.
  const collapsed: StoredMessage[] = [];
  for (const m of ordered) {
    const last = collapsed[collapsed.length - 1];
    if (m.role === "assistant" && last?.role === "assistant") collapsed[collapsed.length - 1] = m;
    else collapsed.push(m);
  }
  // The newest that fit in HISTORY_MAX_CHARS, so a long chat cannot blow the free models' limits.
  const out: { role: "user" | "assistant"; content: string }[] = [];
  let used = 0;
  for (const m of collapsed.slice(-limit).reverse()) {
    if (used + m.text.length > HISTORY_MAX_CHARS) break;
    used += m.text.length;
    out.unshift({ role: m.role, content: m.text });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/** One of her answers by id, with the question it answers and the chat it is in. */
export async function ownAnswer(userId: string, answerId: string, database: Db = defaultDb) {
  if (!isUuid(userId) || !isUuid(answerId)) return null;
  const [answer] = await database
    .select()
    .from(tutorMessages)
    .where(and(eq(tutorMessages.id, answerId), eq(tutorMessages.userId, userId), eq(tutorMessages.role, "assistant")))
    .limit(1);
  if (!answer?.replyTo) return answer ? { answer: toStored(answer), question: null, key: keyOf(answer) } : null;
  const [question] = await database
    .select()
    .from(tutorMessages)
    .where(and(eq(tutorMessages.id, answer.replyTo), eq(tutorMessages.userId, userId)))
    .limit(1);
  return { answer: toStored(answer), question: question ? toStored(question) : null, key: keyOf(answer) };
}

function keyOf(r: typeof tutorMessages.$inferSelect): ChatKey {
  const anchor: TutorAnchor = { kind: r.anchorKind, id: r.anchorId };
  return r.noteId ? { noteId: r.noteId, anchor } : { noteId: null, anchor };
}

export type TurnToStore = {
  userId: string;
  key: ChatKey;
  /** Her new message. Null for "Go deeper", which answers a stored question again. */
  question: { id: string; text: string; quote: string | null } | null;
  /** The question an answer belongs to (the new one, or the stored one for "Go deeper"). */
  replyTo: string;
  answer: { id: string; text: string; model: string; tokens: TokenCounts };
  at?: Date;
};

/** Stores her message (if any) and the answer, in one statement. */
export async function storeTurn(turn: TurnToStore, database: Db = defaultDb): Promise<void> {
  const at = turn.at ?? new Date();
  const base = {
    userId: turn.userId,
    noteId: turn.key.noteId,
    anchorKind: turn.key.anchor.kind,
    anchorId: turn.key.anchor.id,
  };
  const rows: (typeof tutorMessages.$inferInsert)[] = [];
  if (turn.question) {
    rows.push({ ...base, id: turn.question.id, role: "user", body: turn.question.text, quote: turn.question.quote, createdAt: at });
  }
  rows.push({
    ...base,
    id: turn.answer.id,
    role: "assistant",
    body: turn.answer.text,
    replyTo: turn.replyTo,
    model: turn.answer.model,
    tokensIn: turn.answer.tokens.input,
    tokensOut: turn.answer.tokens.output,
    cacheReadTokens: turn.answer.tokens.cacheRead,
    cacheWriteTokens: turn.answer.tokens.cacheWrite,
    tokensEstimated: turn.answer.tokens.estimated,
    // Just after her message, so the two never share a time.
    createdAt: new Date(at.getTime() + 1),
  });
  await database.insert(tutorMessages).values(rows);
}

/** "Save to note": the answer appended to her note's body. Returns the new body, or null. */
export async function appendAnswerToNote(userId: string, noteId: string, answerId: string, database: Db = defaultDb): Promise<string | null> {
  const note = await ownNote(userId, noteId, database);
  const found = await ownAnswer(userId, answerId, database);
  if (!note || !found) return null;
  const text = found.answer.text.trim();
  const body = note.body.trim() ? `${note.body.replace(/\s+$/, "")}\n\n${text}` : text;
  await database
    .update(notes)
    .set({ body, updatedAt: new Date() })
    .where(and(eq(notes.id, note.id), eq(notes.userId, userId)));
  return body;
}

/**
 * Her answer to the tutor's question "May Ready use this course's slides ...": stores
 * `courses.ai_study` for HER course only. Returns the stored rule, or null when the course is
 * not hers (or the id is malformed). The same update as the exam page's own question
 * (src/app/(app)/exams/[id]/page.tsx), without its concepts job (out of scope here).
 */
export async function setStudyRule(
  userId: string,
  courseId: string,
  rule: "allowed" | "not_allowed",
  database: Db = defaultDb,
): Promise<"allowed" | "not_allowed" | null> {
  if (!isUuid(userId) || !isUuid(courseId)) return null;
  const [row] = await database
    .update(courses)
    .set({ aiStudy: rule })
    .where(and(eq(courses.id, courseId), eq(courses.userId, userId)))
    .returning({ aiStudy: courses.aiStudy });
  return row ? (row.aiStudy as "allowed" | "not_allowed") : null;
}

/*
 * M2-19: the draft written with the chat. One draft per assignment; saving again replaces it
 * (latest wins) and keeps the same id.
 *
 *   const draft = await saveDraft(userId, assignmentId, { title, contentMd });
 *   const again = await getDraft(userId, assignmentId); // or null when none was written yet
 *
 * Every call takes the caller's `userId` and checks that the assignment is hers. An assignment
 * that does not exist and one that belongs to someone else both throw the same `DraftNotFound`,
 * so a caller cannot probe for other users' ids.
 *
 * This file only stores. Whether a draft may be written at all (the course's `ai_policy` must be
 * 'allowed') is checked by the `write_draft` tool in src/server/chat/context.ts.
 *
 * Like src/server/chat/store.ts, the database is the last argument and defaults to the shared
 * client, so tests pass a fresh PGlite. Nothing here logs.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb, type Db } from "@/server/db/client";
import { assignments, drafts } from "@/server/db/schema/work";

/** A title longer than this is cut. */
export const DRAFT_TITLE_MAX = 200;
/** Most characters one draft holds. The same as one `read_pages` answer, so it fits a tool round. */
export const DRAFT_MAX_CHARS = 8_000;

export type Draft = typeof drafts.$inferSelect;

export type DraftInput = { title: string; contentMd: string };

/** The assignment does not exist, or belongs to another user. */
export class DraftNotFound extends Error {
  constructor() {
    super("Draft not found.");
    this.name = "DraftNotFound";
  }
}

const inputSchema = z.object({
  title: z.string().trim().min(1),
  contentMd: z.string().trim().min(1).max(DRAFT_MAX_CHARS),
});

async function ownedAssignment(database: Db, userId: string, assignmentId: string): Promise<void> {
  if (!z.uuid().safeParse(assignmentId).success) throw new DraftNotFound();
  const [assignment] = await database
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.id, assignmentId), eq(assignments.userId, userId)))
    .limit(1);
  if (!assignment) throw new DraftNotFound();
}

/**
 * Saves the draft for this assignment, replacing the one before it. Throws `DraftNotFound` when
 * the assignment is not hers, and a `ZodError` when the title or text is empty or the text is
 * longer than `DRAFT_MAX_CHARS`.
 */
export async function saveDraft(
  userId: string,
  assignmentId: string,
  input: DraftInput,
  database: Db = defaultDb,
): Promise<Draft> {
  const checked = inputSchema.parse(input);
  await ownedAssignment(database, userId, assignmentId);
  const title = checked.title.replace(/\s+/g, " ").slice(0, DRAFT_TITLE_MAX);
  const now = new Date();

  const [row] = await database
    .insert(drafts)
    .values({ userId, assignmentId, title, contentMd: checked.contentMd, updatedAt: now })
    .onConflictDoUpdate({
      target: drafts.assignmentId,
      set: { title, contentMd: checked.contentMd, updatedAt: now },
      // The row for her assignment is hers; never write over one that is not.
      setWhere: eq(drafts.userId, userId),
    })
    .returning();
  if (!row) throw new DraftNotFound();
  return row;
}

/** The draft for this assignment, or null when none was written yet. */
export async function getDraft(
  userId: string,
  assignmentId: string,
  database: Db = defaultDb,
): Promise<Draft | null> {
  await ownedAssignment(database, userId, assignmentId);
  const [row] = await database
    .select()
    .from(drafts)
    .where(and(eq(drafts.assignmentId, assignmentId), eq(drafts.userId, userId)))
    .limit(1);
  return row ?? null;
}

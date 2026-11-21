/*
 * "Download my data" (M8-06): everything stored for one user, as one plain
 * JSON-serialisable object.
 *
 * Every table in the schema has exactly one entry below:
 * - `EXPORT_PLAN`: tables that belong to a user, either exported or
 *   excluded with a written reason. User-owned means a `user_id` column (or
 *   `users` itself), or a child table that reaches one through a foreign key
 *   (file pages, chat messages, card states, ...). Child rows are selected
 *   through the parent join, so only her rows come back.
 * - `GLOBAL_TABLES`: tables that hold nobody's data.
 * `collect.test.ts` finds the user-owned tables from the schema the same way
 * mergeUsers does, so a new table without an entry here fails the test.
 *
 * Secrets never leave: `NEVER_EXPORT` columns are dropped from every table,
 * and each entry can drop more with `omit`.
 */
import { asc, eq, getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@/server/db/client";
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
  mockExamAttempts,
  mockExams,
  reviews,
  studySessions,
} from "@/server/db/schema/study";
import { aiCache, aiCalls, jobs, providerCooldowns, usageEvents } from "@/server/db/schema/system";
import { confirmCodes, identities, sessions, users } from "@/server/db/schema/users";
import { assignments, chatMessages, chats, drafts, submissions } from "@/server/db/schema/work";

export const EXPORT_VERSION = 1;

/** Database column names that are never written to an export, whatever the table. */
export const NEVER_EXPORT = ["token_sealed", "private_token_sealed", "token_hash", "payload_hash"] as const;

type AnyTable = PgTable & { id: PgColumn; createdAt: PgColumn };
type OwnedTable = AnyTable & { userId: PgColumn };

export type PlanEntry =
  /** Rows where `user_id` is hers (or, for `users`, `id`). */
  | { kind: "own"; table: AnyTable; by: PgColumn; omit?: string[] }
  /** Rows of a child table, joined to a parent she owns through `fk`. */
  | { kind: "child"; table: AnyTable; fk: PgColumn; parent: OwnedTable; omit?: string[] }
  /** Kept out of the export on purpose. */
  | { kind: "exclude"; table: PgTable; reason: string };

const own = (table: OwnedTable, omit?: string[]): PlanEntry => ({ kind: "own", table, by: table.userId, omit });
const child = (table: AnyTable, fk: PgColumn, parent: OwnedTable, omit?: string[]): PlanEntry => ({
  kind: "child",
  table,
  fk,
  parent,
  omit,
});
const exclude = (table: PgTable, reason: string): PlanEntry => ({ kind: "exclude", table, reason });

export const EXPORT_PLAN: PlanEntry[] = [
  // Who she is.
  { kind: "own", table: users, by: users.id },
  // Her devices: when each was first and last seen. The token hash is dropped.
  own(sessions),
  own(identities),
  exclude(
    confirmCodes,
    "Short-lived hand-in confirmation codes: only a hash and an expiry time, nothing she wrote.",
  ),
  // The MyCourses connection without its sealed keys.
  own(moodleConnections),

  // Courses and their material.
  own(courses),
  own(courseFiles),
  child(filePages, filePages.fileId, courseFiles, ["tsv"]),

  // Work.
  own(assignments),
  own(submissions),
  own(chats),
  child(chatMessages, chatMessages.chatId, chats),
  own(drafts),

  // Calendar and reminders.
  own(events),
  // That a calendar subscription exists; the feed's secret token hash is dropped.
  own(calendarFeeds),
  exclude(
    pushSubscriptions,
    "Browser push registrations: the endpoint and keys are delivery secrets for one browser, not something she made.",
  ),
  own(reminderLog),

  // Grades.
  own(gradeItems),

  // Study.
  own(exams),
  own(examDocuments),
  own(concepts),
  own(cards),
  child(cardConcepts, cardConcepts.cardId, cards),
  child(cardStates, cardStates.cardId, cards),
  own(studySessions),
  own(reviews),
  own(mockExams),
  own(mockExamAttempts),

  // Lecture pages and notes.
  own(lectures),
  child(lectureContent, lectureContent.lectureId, lectures),
  child(lectureConcepts, lectureConcepts.lectureId, lectures),
  own(notes),
  own(highlights),
  // Her tutor chats: her messages, the answers, which model answered and the tokens it used.
  own(tutorMessages),

  // System rows that point at her.
  exclude(
    jobs,
    "The background work queue: transient sync and AI tasks whose results are already in the tables above.",
  ),
  // Which AI provider and model answered her, how long it took. No prompts or replies are stored.
  own(aiCalls),
  own(usageEvents),
];

/** Tables that hold nobody's data, so there is nothing of hers to export. */
export const GLOBAL_TABLES: { table: PgTable; reason: string }[] = [
  { table: aiCache, reason: "Shared AI answer cache keyed by a content hash; not tied to any user." },
  { table: providerCooldowns, reason: "Per-provider rate-limit timers; not tied to any user." },
];

export const tableName = (table: PgTable) => getTableConfig(table).name;

type Row = Record<string, unknown>;

export type ExportFile = {
  version: number;
  exportedAt: string;
  userId: string;
  /** SQL table name -> her rows, oldest first. */
  tables: Record<string, Row[]>;
  /** SQL table name -> why it is not in `tables`. */
  excluded: Record<string, string>;
};

/** Every column of `table` except the never-export ones and `omit` (database names). */
function columnsOf(table: PgTable, omit: string[] = []): Record<string, PgColumn> {
  const drop = new Set<string>([...NEVER_EXPORT, ...omit]);
  const out: Record<string, PgColumn> = {};
  for (const [key, column] of Object.entries(getTableColumns(table) as Record<string, PgColumn>)) {
    if (!drop.has(column.name)) out[key] = column;
  }
  return out;
}

/** Dates as ISO strings, so the object is plain JSON with no `toJSON` surprises. */
function plain(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) out[key] = value instanceof Date ? value.toISOString() : value;
  return out;
}

async function rowsFor(database: Db, entry: Exclude<PlanEntry, { kind: "exclude" }>, userId: string) {
  const fields = columnsOf(entry.table, entry.omit);
  const order = [asc(entry.table.createdAt), asc(entry.table.id)];
  const rows =
    entry.kind === "own"
      ? await database.select(fields).from(entry.table).where(eq(entry.by, userId)).orderBy(...order)
      : await database
          .select(fields)
          .from(entry.table)
          .innerJoin(entry.parent, eq(entry.fk, entry.parent.id))
          .where(eq(entry.parent.userId, userId))
          .orderBy(...order);
  return (rows as Row[]).map(plain);
}

/** Everything stored for `userId`, ready for `JSON.stringify`. */
export async function collectExport(database: Db, userId: string, now: Date = new Date()): Promise<ExportFile> {
  const tables: Record<string, Row[]> = {};
  const excluded: Record<string, string> = {};
  for (const entry of EXPORT_PLAN) {
    const name = tableName(entry.table);
    if (entry.kind === "exclude") excluded[name] = entry.reason;
    else tables[name] = await rowsFor(database, entry, userId);
  }
  return { version: EXPORT_VERSION, exportedAt: now.toISOString(), userId, tables, excluded };
}

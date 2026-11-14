/**
 * Study storage: decks, reviews and sessions (ticket M3-17).
 *
 * Every function takes the signed-in `userId` and only ever reads or writes
 * that user's rows. An exam, card or session that does not exist, or belongs
 * to someone else, is refused with `StudyNotFound` (the two cases look the
 * same from outside, so nothing leaks about other users' ids). Like the
 * other server modules, the database handle is the last argument and
 * defaults to the app's `db`; functions that depend on the time take `now`.
 *
 * Choices:
 * - `loadDeck` returns concepts in `position` order and the exam's `active`
 *   cards (flagged and suspended ones are left out) in creation order, each
 *   with its stored memory (`null` when never graded) and concept ids.
 * - `startSession` checks the card ids (hers, in this exam) and keeps them in
 *   `summary.cardIds`: the schema has no column for them, and `summary` is
 *   the session's own JSON. `finishSession` merges its summary on top, so
 *   the ids stay; `ended_at` is set once (a second finish keeps the first
 *   time but takes the newer summary).
 * - `recordReviews` runs in one transaction. Idempotency by
 *   `(session_id, card_id, at)`: the schema has no unique key on those, so
 *   the session row is locked (`select ... for update`), which serialises
 *   concurrent calls for one session, and reviews already stored with the
 *   same card and instant (to the millisecond) are skipped, as are repeats
 *   inside the batch. The new ones are applied to each card's memory in time
 *   order with `grade` from `src/lib/study/memory.ts` (a card with no state
 *   starts from `newCard` at its first review), then `card_states` gets the
 *   new `fsrs`, `due_at`, `lapses` and `last_review_at`. A skipped review
 *   never changes a card's state, so sending the same batch twice is a no-op.
 *   Cards must be hers and in the session's exam. Grades are 1..4.
 * - Days are Helsinki calendar days, keys `YYYY-MM-DD`, computed with
 *   `Intl` like `src/lib/dates.ts` (not in SQL, so PGlite and Neon agree).
 *   A key parses with `new Date(key)` to an instant inside that Helsinki
 *   day, so `reviewDays` can be handed straight to `weekOf`.
 * - `countsToday`: over active cards. `new` never graded; `learning` in
 *   (re)learning and due by the end of today; `due` in review and due by the
 *   end of today (overdue included).
 * - `bitesDoneToday`: `bite` sessions for the exam that ended today.
 * - `upcoming`: graded active cards per due day, from today on (overdue ones
 *   count for today); only days with cards, earliest first.
 * - `last14`: review rows (every grade) per day for the 14 days ending
 *   today, oldest first, zeros included.
 */
import { and, asc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import {
  cardConcepts,
  cards,
  cardStates,
  CARD_STATUSES,
  concepts,
  exams,
  reviews,
  SESSION_MODES,
  studySessions,
} from "@/server/db/schema/study";
import { TIME_ZONE } from "@/lib/dates";
import { grade as gradeMemory, newCard, type Grade, type MemoryState } from "@/lib/study/memory";
import type { Review, SessionMode, SessionResult } from "@/lib/study/session";

export class StudyNotFound extends Error {
  constructor(what: "exam" | "card" | "session", id: string) {
    super(`No ${what} ${id} for this user.`);
    this.name = "StudyNotFound";
  }
}

export type Concept = typeof concepts.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type StudySession = typeof studySessions.$inferSelect;

export type CardMemory = {
  fsrs: MemoryState;
  dueAt: Date;
  lapses: number;
  lastReviewAt: Date | null;
};

export type DeckCard = Card & { conceptIds: string[]; memory: CardMemory | null };

export type Deck = { concepts: Concept[]; cards: DeckCard[] };

/** A graded card as the session screen reports it, plus when it was graded. */
export type ReviewInput = Review & { at: Date | string | number };

/** What a finished session keeps; the reviews themselves are stored as rows. */
export type SessionSummary = Partial<Omit<SessionResult, "reviews">> & Record<string, unknown>;

export type FlagStatus = Extract<(typeof CARD_STATUSES)[number], "flagged" | "suspended">;

export type DayCount = { day: string; count: number };

export type TodayCounts = { new: number; learning: number; due: number };

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helsinki day keys

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/** The Helsinki calendar day of an instant, as `YYYY-MM-DD`. */
export function dayKey(at: Date | string | number): string {
  const out: Record<string, number> = {};
  for (const p of dayFormat.formatToParts(at instanceof Date ? at : new Date(at))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return keyOfUtc(Date.UTC(out.year, out.month - 1, out.day));
}

function keyOfUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Calendar arithmetic on a day key (no time zone involved). */
function addDays(key: string, n: number): string {
  return keyOfUtc(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS);
}

// ---------------------------------------------------------------------------
// Ownership checks

type Tx = Db;

async function assertExam(tx: Tx, userId: string, examId: string): Promise<void> {
  const [found] = await tx
    .select({ id: exams.id })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)));
  if (!found) throw new StudyNotFound("exam", examId);
}

/** Every id must be one of her cards in `examId`; refuses the first that is not. */
async function assertCards(tx: Tx, userId: string, examId: string, cardIds: readonly string[]): Promise<void> {
  const unique = [...new Set(cardIds)];
  if (unique.length === 0) return;
  const found = await tx
    .select({ id: cards.id })
    .from(cards)
    .where(and(inArray(cards.id, unique), eq(cards.userId, userId), eq(cards.examId, examId)));
  const ok = new Set(found.map((c) => c.id));
  const bad = unique.find((id) => !ok.has(id));
  if (bad) throw new StudyNotFound("card", bad);
}

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Ids that are not uuids would make Postgres throw a cast error; refuse them the same way. */
function checkIds(what: "exam" | "card" | "session", ids: readonly string[]): void {
  const bad = ids.find((id) => !isUuid(id));
  if (bad !== undefined) throw new StudyNotFound(what, bad);
}

// ---------------------------------------------------------------------------
// Deck

export async function loadDeck(userId: string, examId: string, database: Db = defaultDb): Promise<Deck> {
  checkIds("exam", [examId]);
  await assertExam(database, userId, examId);

  const conceptRows = await database
    .select()
    .from(concepts)
    .where(and(eq(concepts.examId, examId), eq(concepts.userId, userId)))
    .orderBy(asc(concepts.position), asc(concepts.createdAt), asc(concepts.id));

  const rows = await database
    .select({ card: cards, state: cardStates })
    .from(cards)
    .leftJoin(cardStates, eq(cardStates.cardId, cards.id))
    .where(and(eq(cards.examId, examId), eq(cards.userId, userId), eq(cards.status, "active")))
    .orderBy(asc(cards.createdAt), asc(cards.id));

  const cardIds = rows.map((r) => r.card.id);
  const links = cardIds.length
    ? await database
        .select({ cardId: cardConcepts.cardId, conceptId: cardConcepts.conceptId })
        .from(cardConcepts)
        .where(inArray(cardConcepts.cardId, cardIds))
    : [];
  const order = new Map(conceptRows.map((c, i) => [c.id, i]));
  const byCard = new Map<string, string[]>();
  for (const l of links) {
    if (!order.has(l.conceptId)) continue; // a link to a concept outside this exam
    const list = byCard.get(l.cardId) ?? [];
    list.push(l.conceptId);
    byCard.set(l.cardId, list);
  }

  return {
    concepts: conceptRows,
    cards: rows.map(({ card, state }) => ({
      ...card,
      conceptIds: (byCard.get(card.id) ?? []).sort((a, b) => order.get(a)! - order.get(b)!),
      memory: state
        ? {
            fsrs: state.fsrs as MemoryState,
            dueAt: state.dueAt,
            lapses: state.lapses,
            lastReviewAt: state.lastReviewAt,
          }
        : null,
    })),
  };
}

export async function flagCard(
  userId: string,
  cardId: string,
  status: FlagStatus,
  database: Db = defaultDb,
): Promise<void> {
  if (status !== "flagged" && status !== "suspended") throw new Error(`flagCard: unknown status ${String(status)}`);
  checkIds("card", [cardId]);
  const updated = await database
    .update(cards)
    .set({ status })
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
    .returning({ id: cards.id });
  if (updated.length === 0) throw new StudyNotFound("card", cardId);
}

// ---------------------------------------------------------------------------
// Sessions

export async function startSession(
  userId: string,
  examId: string,
  mode: SessionMode,
  cardIds: readonly string[],
  now: Date = new Date(),
  database: Db = defaultDb,
): Promise<StudySession> {
  if (!(SESSION_MODES as readonly string[]).includes(mode)) throw new Error(`startSession: unknown mode ${mode}`);
  checkIds("exam", [examId]);
  checkIds("card", cardIds);
  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await assertExam(tx, userId, examId);
    await assertCards(tx, userId, examId, cardIds);
    const [row] = await tx
      .insert(studySessions)
      .values({ userId, examId, mode, startedAt: now, summary: { cardIds: [...cardIds] } })
      .returning();
    return row;
  });
}

export async function finishSession(
  userId: string,
  sessionId: string,
  summary: SessionSummary,
  now: Date = new Date(),
  database: Db = defaultDb,
): Promise<StudySession> {
  checkIds("session", [sessionId]);
  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [session] = await tx
      .select()
      .from(studySessions)
      .where(and(eq(studySessions.id, sessionId), eq(studySessions.userId, userId)))
      .for("update");
    if (!session) throw new StudyNotFound("session", sessionId);
    const before = (session.summary ?? {}) as Record<string, unknown>;
    const [row] = await tx
      .update(studySessions)
      .set({ endedAt: session.endedAt ?? now, summary: { ...before, ...summary, cardIds: before.cardIds ?? [] } })
      .where(eq(studySessions.id, sessionId))
      .returning();
    return row;
  });
}

// ---------------------------------------------------------------------------
// Reviews

function toInstant(at: ReviewInput["at"]): Date {
  const d = at instanceof Date ? new Date(at.getTime()) : new Date(at);
  if (Number.isNaN(d.getTime())) throw new Error(`recordReviews: invalid review time ${String(at)}`);
  return d;
}

function checkGrade(g: number): Grade {
  if (g !== 1 && g !== 2 && g !== 3 && g !== 4) throw new Error(`recordReviews: grade must be 1 to 4, got ${g}`);
  return g;
}

export async function recordReviews(
  userId: string,
  sessionId: string,
  batch: readonly ReviewInput[],
  database: Db = defaultDb,
): Promise<{ stored: number; skipped: number }> {
  checkIds("session", [sessionId]);
  checkIds("card", batch.map((r) => r.cardId));
  const incoming = batch.map((r) => ({
    cardId: r.cardId,
    grade: checkGrade(r.grade),
    firstTry: Boolean(r.firstTry),
    ms: Number.isFinite(r.ms) ? Math.max(0, Math.round(r.ms)) : null,
    at: toInstant(r.at),
  }));

  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // Locks the session row: a second call for the same session waits here
    // until this one commits, then sees its rows and skips them.
    const [session] = await tx
      .select({ id: studySessions.id, examId: studySessions.examId })
      .from(studySessions)
      .where(and(eq(studySessions.id, sessionId), eq(studySessions.userId, userId)))
      .for("update");
    if (!session) throw new StudyNotFound("session", sessionId);
    if (incoming.length === 0) return { stored: 0, skipped: 0 };

    const cardIds = [...new Set(incoming.map((r) => r.cardId))];
    await assertCards(tx, userId, session.examId, cardIds);

    const existing = await tx
      .select({ cardId: reviews.cardId, at: reviews.at })
      .from(reviews)
      .where(and(eq(reviews.sessionId, sessionId), inArray(reviews.cardId, cardIds)));
    const seen = new Set(existing.map((r) => `${r.cardId}@${r.at.getTime()}`));
    const fresh: typeof incoming = [];
    for (const r of incoming) {
      const key = `${r.cardId}@${r.at.getTime()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(r);
    }
    const skipped = incoming.length - fresh.length;
    if (fresh.length === 0) return { stored: 0, skipped };

    await tx.insert(reviews).values(fresh.map((r) => ({ ...r, userId, sessionId })));

    const touched = [...new Set(fresh.map((r) => r.cardId))];
    const states = await tx
      .select({ cardId: cardStates.cardId, fsrs: cardStates.fsrs })
      .from(cardStates)
      .where(inArray(cardStates.cardId, touched));
    const memory = new Map(states.map((s) => [s.cardId, s.fsrs as MemoryState]));

    const inOrder = [...fresh].sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const r of inOrder) {
      const before = memory.get(r.cardId) ?? newCard(r.at);
      memory.set(r.cardId, gradeMemory(before, r.grade, r.at));
    }

    for (const cardId of touched) {
      const fsrs = memory.get(cardId)!;
      const values = {
        fsrs,
        dueAt: new Date(fsrs.dueAt),
        lapses: fsrs.lapses,
        lastReviewAt: fsrs.lastReviewAt === null ? null : new Date(fsrs.lastReviewAt),
      };
      await tx
        .insert(cardStates)
        .values({ cardId, ...values })
        .onConflictDoUpdate({ target: cardStates.cardId, set: values });
    }

    return { stored: fresh.length, skipped };
  });
}

// ---------------------------------------------------------------------------
// Counts by day

/** Helsinki days (`YYYY-MM-DD`, earliest first) with at least one review at or after `since`. */
export async function reviewDays(
  userId: string,
  since: Date,
  database: Db = defaultDb,
): Promise<string[]> {
  const rows = await database
    .select({ at: reviews.at })
    .from(reviews)
    .where(and(eq(reviews.userId, userId), gte(reviews.at, since)));
  return [...new Set(rows.map((r) => dayKey(r.at)))].sort();
}

async function activeCardStates(database: Db, userId: string, examId: string) {
  checkIds("exam", [examId]);
  await assertExam(database, userId, examId);
  return database
    .select({ fsrs: cardStates.fsrs, dueAt: cardStates.dueAt })
    .from(cards)
    .leftJoin(cardStates, eq(cardStates.cardId, cards.id))
    .where(and(eq(cards.examId, examId), eq(cards.userId, userId), eq(cards.status, "active")));
}

export async function countsToday(
  userId: string,
  examId: string,
  now: Date = new Date(),
  database: Db = defaultDb,
): Promise<TodayCounts> {
  const today = dayKey(now);
  const counts: TodayCounts = { new: 0, learning: 0, due: 0 };
  for (const row of await activeCardStates(database, userId, examId)) {
    const state = (row.fsrs as MemoryState | null)?.state ?? 0;
    if (state === 0 || !row.dueAt) {
      counts.new += 1;
      continue;
    }
    if (dayKey(row.dueAt) > today) continue;
    if (state === 2) counts.due += 1;
    else counts.learning += 1;
  }
  return counts;
}

export async function bitesDoneToday(
  userId: string,
  examId: string,
  now: Date = new Date(),
  database: Db = defaultDb,
): Promise<number> {
  checkIds("exam", [examId]);
  await assertExam(database, userId, examId);
  const rows = await database
    .select({ endedAt: studySessions.endedAt })
    .from(studySessions)
    .where(
      and(
        eq(studySessions.userId, userId),
        eq(studySessions.examId, examId),
        eq(studySessions.mode, "bite"),
        isNotNull(studySessions.endedAt),
        // A day is at most 25 hours; the exact check is by day key below.
        gte(studySessions.endedAt, new Date(now.getTime() - 2 * DAY_MS)),
      ),
    );
  const today = dayKey(now);
  return rows.filter((r) => r.endedAt && dayKey(r.endedAt) === today).length;
}

export async function upcoming(
  userId: string,
  examId: string,
  now: Date = new Date(),
  database: Db = defaultDb,
): Promise<DayCount[]> {
  const today = dayKey(now);
  const per = new Map<string, number>();
  for (const row of await activeCardStates(database, userId, examId)) {
    const state = (row.fsrs as MemoryState | null)?.state ?? 0;
    if (state === 0 || !row.dueAt) continue;
    const key = dayKey(row.dueAt);
    const day = key < today ? today : key;
    per.set(day, (per.get(day) ?? 0) + 1);
  }
  return [...per]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, count]) => ({ day, count }));
}

export async function last14(
  userId: string,
  examId: string,
  now: Date = new Date(),
  database: Db = defaultDb,
): Promise<DayCount[]> {
  checkIds("exam", [examId]);
  await assertExam(database, userId, examId);
  const today = dayKey(now);
  const first = addDays(today, -13);
  const rows = await database
    .select({ at: reviews.at })
    .from(reviews)
    .innerJoin(cards, eq(cards.id, reviews.cardId))
    .where(
      and(
        eq(reviews.userId, userId),
        eq(cards.userId, userId),
        eq(cards.examId, examId),
        gte(reviews.at, new Date(now.getTime() - 15 * DAY_MS)),
      ),
    );
  const per = new Map<string, number>();
  for (const r of rows) {
    const key = dayKey(r.at);
    if (key < first || key > today) continue;
    per.set(key, (per.get(key) ?? 0) + 1);
  }
  return Array.from({ length: 14 }, (_, i) => {
    const day = addDays(first, i);
    return { day, count: per.get(day) ?? 0 };
  });
}

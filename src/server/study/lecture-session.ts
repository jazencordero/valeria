/**
 * "Practise this lecture" (M9-15): a study session with every card tied to
 * one lecture's concepts, and the safe path the session goes back to.
 *
 *   const cards = await lectureCards(userId, lectureId);          // what the button may count
 *   const begun = await beginLectureSession(userId, lectureId);   // null: nothing to practise
 *   const back = safeReturn(q.get("return"));                     // null: not a same-site path
 *
 * Called by GET /study/new (`?lecture=<id>&return=<path>`) with the user
 * from the session cookie; this is a plain server module, not a "use server"
 * file, so taking a user id is fine.
 *
 * Choices:
 * - Cards: her active cards linked to any of the lecture's concepts
 *   (lecture_concepts -> card_concepts), each once, as the course path counts
 *   them (src/server/courses/store.ts). Flagged or skipped cards stay out.
 * - A session belongs to one exam. When the lecture's cards sit in more than
 *   one exam, the exam with the most of them is used (ties: the earliest
 *   exam, then the lowest id), and the count the lecture page shows is that
 *   exam's, so the button never claims cards the session will not hold.
 * - Order: deck order (created, then id), boss cards last, as a concept
 *   session orders them (`conceptSession` in src/lib/study/bite.ts). Mode is
 *   `concept`: the session page then puts boss cards in boss and the rest in
 *   learn, and the done screen offers no "One more bite".
 * - Every card, not four: the ticket asks for all of them, and new cards are
 *   allowed even before the exam's study start, since she asked for this
 *   lecture by hand.
 * - The session's summary gets `forecastBefore` and `masteryBefore` the way
 *   `beginSession` writes them (mastery per concept from cards whose first
 *   concept it is, then `forecastNow`), so `endSession` can say what moved.
 * - `safeReturn`: a path on this site only. It must start with one "/", and
 *   may not start with "//" or "/\" (both mean another host to a browser),
 *   hold a backslash, a control character or whitespace, or be longer than
 *   500 characters. A path can never carry a scheme, since it starts with "/".
 */
import { and, asc, eq } from "drizzle-orm";
import { forecastNow } from "@/lib/study/forecast";
import { conceptMastery } from "@/lib/study/ladder";
import { newCard } from "@/lib/study/memory";
import { db as defaultDb, type Db } from "@/server/db/client";
import { lectureConcepts, lectures } from "@/server/db/schema/learn";
import { cardConcepts, cards, exams, studySessions } from "@/server/db/schema/study";
import { loadDeck, startSession } from "@/server/study/store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETURN_MAX = 500;

/** A same-site path to go back to, or null. */
export function safeReturn(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > RETURN_MAX) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  // A backslash reads as a slash to browsers ("/\evil.example"); no whitespace or control characters.
  if (/[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export type LectureCards = {
  /** The exam the session would run in; null when the lecture has no cards. */
  examId: string | null;
  /** Card ids in session order (boss cards last). */
  cardIds: string[];
};

const NONE: LectureCards = { examId: null, cardIds: [] };

/** Her active cards tied to the lecture's concepts, in one exam. An unknown lecture or someone else's has none. */
export async function lectureCards(userId: string, lectureId: string, database: Db = defaultDb): Promise<LectureCards> {
  if (!UUID.test(lectureId)) return NONE;
  const [lecture] = await database
    .select({ id: lectures.id })
    .from(lectures)
    .where(and(eq(lectures.id, lectureId), eq(lectures.userId, userId)));
  if (!lecture) return NONE;

  const rows = await database
    .selectDistinct({
      id: cards.id,
      examId: cards.examId,
      boss: cards.boss,
      createdAt: cards.createdAt,
      examAt: exams.at,
    })
    .from(lectureConcepts)
    .innerJoin(cardConcepts, eq(cardConcepts.conceptId, lectureConcepts.conceptId))
    .innerJoin(cards, eq(cards.id, cardConcepts.cardId))
    .innerJoin(exams, eq(exams.id, cards.examId))
    .where(and(eq(lectureConcepts.lectureId, lectureId), eq(cards.userId, userId), eq(cards.status, "active")))
    .orderBy(asc(cards.createdAt), asc(cards.id));
  if (rows.length === 0) return NONE;

  const byExam = new Map<string, { n: number; at: number }>();
  for (const r of rows) {
    const e = byExam.get(r.examId) ?? { n: 0, at: r.examAt.getTime() };
    e.n++;
    byExam.set(r.examId, e);
  }
  const [examId] = [...byExam.entries()].sort(
    ([a, x], [b, y]) => y.n - x.n || x.at - y.at || (a < b ? -1 : a > b ? 1 : 0),
  )[0];

  const mine = rows.filter((r) => r.examId === examId);
  return {
    examId,
    cardIds: [...mine.filter((r) => !r.boss), ...mine.filter((r) => r.boss)].map((r) => r.id),
  };
}

export type BegunLectureSession = { sessionId: string; examId: string; cards: number };

/**
 * Starts a `concept` session with every card of the lecture. Null when it has
 * none (or is not hers); no session row is written then.
 */
export async function beginLectureSession(
  userId: string,
  lectureId: string,
  now: Date = new Date(),
  database: Db = defaultDb,
): Promise<BegunLectureSession | null> {
  const { examId, cardIds } = await lectureCards(userId, lectureId, database);
  if (!examId || cardIds.length === 0) return null;

  const [exam] = await database
    .select({ at: exams.at })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)));
  if (!exam) return null;

  // Before numbers, as beginSession stores them.
  const deck = await loadDeck(userId, examId, database);
  const masteryBefore: Record<string, number> = {};
  for (const concept of deck.concepts) {
    const own = deck.cards
      .filter((c) => c.conceptIds[0] === concept.id)
      .map((c) => ({ state: c.memory?.fsrs ?? newCard(exam.at), active: c.status === "active" }));
    masteryBefore[concept.id] = conceptMastery(own, exam.at);
  }
  const forecastBefore = forecastNow(deck.concepts.map((c) => ({ weight: c.weight, mastery: masteryBefore[c.id] ?? 0 })));

  const session = await startSession(userId, examId, "concept", cardIds, now, database);
  await database
    .update(studySessions)
    .set({ summary: { ...(session.summary as Record<string, unknown>), lectureId, forecastBefore, masteryBefore } })
    .where(eq(studySessions.id, session.id));
  return { sessionId: session.id, examId, cards: cardIds.length };
}

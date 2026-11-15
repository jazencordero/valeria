"use server";

/**
 * M9-17: turn a note into cards. Two Server Actions, called by the notepad.
 *
 * - `addCardsFromNote(noteId, cards, examId?)`: stores up to 3 recall cards
 *   (`type 'basic'`, `{ q: front, a: back }`, `origin 'note'`) from one of
 *   her notes. Which exam they go on:
 *   - a note attached to an exam: that exam;
 *   - a note with a course (attached to it, or to one of its lectures or
 *     assignments): the course's next exam (the earliest one not yet past,
 *     exam or quiz). With none, nothing is stored and the answer is
 *     `no_exam`: the drawer says so and links to adding one;
 *   - a General note: the `examId` she chose, which must be one of her exams
 *     not yet past; without one the answer is `choose_exam`.
 *   Each card's source is the note's attachment label, as the Notes tab pill
 *   shows it ("Lecture 5 · Sourcing and vendors", "General"). A lecture
 *   note's cards are tied to that lecture's first concept in the chosen
 *   exam (`lecture_concepts`), when there is one; otherwise they have no
 *   concept. Every card is due now (first review today): a fresh memory
 *   state and `due_at = now`.
 *   Rows with an empty front or back are skipped (`usableCards`); none left
 *   is `empty`. A card she already has (same `content_hash` for her, in any
 *   exam) is skipped and counted in `skipped`, never stored twice; `added`
 *   is what was really stored, and `course` is the exam's course short name
 *   for the toast. A note that is not hers (or gone) is `not_found`.
 *   Before an exam's `start_new_on` day, sessions still hold back cards she
 *   has never graded (M3-53, `studyDeckOf` in src/server/study/actions.ts);
 *   that rule is not changed here.
 * - `noteCardExams()`: her exams not yet past, soonest first, for the
 *   General note's "Which exam?" select.
 *
 * Who she is comes from the session cookie. Every export of a "use server"
 * file is a public endpoint, so nothing exported takes a user id (the
 * notepad is a client component, so it can only call actions from a
 * file-level "use server" module); the inputs are checked with zod.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { attachLabel, type AttachLookups } from "@/lib/notes/attach";
import { MAX_CARDS, usableCards } from "@/lib/notes/to-cards";
import { contentHash, type BasicCard } from "@/lib/study/card-schema";
import { newCard } from "@/lib/study/memory";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { shortNameOf } from "@/server/data/courses";
import { examNotPast } from "@/server/data/exams";
import { db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { lectureConcepts, lectures } from "@/server/db/schema/learn";
import { cardConcepts, cards, cardStates, concepts, exams } from "@/server/db/schema/study";
import { assignments } from "@/server/db/schema/work";
import { getNote, type Note } from "@/server/notes/store";

export type AddCardsResult =
  | { ok: true; added: number; skipped: number; course: string }
  | { ok: false; reason: "no_exam" }
  | { ok: false; reason: "choose_exam" }
  | { ok: false; reason: "empty" | "invalid" | "not_found" | "signed_out" };

export type ExamChoice = { id: string; label: string };
export type ExamChoicesResult = { ok: true; exams: ExamChoice[] } | { ok: false; reason: "signed_out" };

const Cards = z
  .array(z.object({ front: z.string().max(500), back: z.string().max(2_000) }))
  .max(MAX_CARDS);

async function userIdOrNull(): Promise<string | null> {
  try {
    return (await currentUser()).id;
  } catch (err) {
    if (err instanceof NotSignedIn) return null;
    throw err;
  }
}

type TargetExam = { id: string; courseName: string };

/** Her exams not yet past, soonest first, with the course name. */
async function upcomingExams(userId: string, now: Date, courseId?: string) {
  const where = [eq(exams.userId, userId), examNotPast(now)];
  if (courseId) where.push(eq(exams.courseId, courseId));
  return db
    .select({ id: exams.id, title: exams.title, courseName: courses.name })
    .from(exams)
    .innerJoin(courses, eq(courses.id, exams.courseId))
    .where(and(...where))
    .orderBy(asc(exams.at), asc(exams.id));
}

/** The exam the note's cards go on; null means none (see the header). */
async function targetExam(
  userId: string,
  note: Note,
  examId: string | undefined,
  now: Date,
): Promise<TargetExam | "no_exam" | "choose_exam"> {
  if (note.attach.kind === "exam" && note.attach.id) {
    const [e] = await db
      .select({ id: exams.id, courseName: courses.name })
      .from(exams)
      .innerJoin(courses, eq(courses.id, exams.courseId))
      .where(and(eq(exams.id, note.attach.id), eq(exams.userId, userId)));
    if (e) return e;
  }
  if (note.courseId) {
    const [next] = await upcomingExams(userId, now, note.courseId);
    return next ?? "no_exam";
  }
  if (!examId) return "choose_exam";
  const chosen = (await upcomingExams(userId, now)).find((e) => e.id === examId);
  return chosen ?? "choose_exam";
}

/** The note's attachment label, as the Notes tab pill shows it. */
async function sourceLabel(userId: string, note: Note): Promise<string> {
  const { kind, id } = note.attach;
  if (kind === "general" || !id) return attachLabel(note, {});
  const lookups: AttachLookups = {};
  if (kind === "course") {
    const [c] = await db
      .select({ name: courses.name })
      .from(courses)
      .where(and(eq(courses.id, id), eq(courses.userId, userId)));
    if (c) lookups.courses = { [id]: { name: shortNameOf(c.name) } };
  } else if (kind === "lecture") {
    const [l] = await db
      .select({ n: lectures.n, title: lectures.title })
      .from(lectures)
      .where(and(eq(lectures.id, id), eq(lectures.userId, userId)));
    if (l) lookups.lectures = { [id]: l };
  } else if (kind === "assignment") {
    const [a] = await db
      .select({ name: assignments.name })
      .from(assignments)
      .where(and(eq(assignments.id, id), eq(assignments.userId, userId)));
    if (a) lookups.assignments = { [id]: a };
  } else {
    const [e] = await db
      .select({ kind: exams.kind, title: exams.title, courseName: courses.name })
      .from(exams)
      .innerJoin(courses, eq(courses.id, exams.courseId))
      .where(and(eq(exams.id, id), eq(exams.userId, userId)));
    if (e) lookups.exams = { [id]: { ...e, courseName: shortNameOf(e.courseName) } };
  }
  return attachLabel(note, lookups);
}

/** A lecture note's concept in that exam: the lecture's first, by position. */
async function lectureConcept(note: Note, examId: string): Promise<string | null> {
  if (note.attach.kind !== "lecture" || !note.attach.id) return null;
  const [row] = await db
    .select({ id: concepts.id })
    .from(lectureConcepts)
    .innerJoin(concepts, eq(concepts.id, lectureConcepts.conceptId))
    .where(and(eq(lectureConcepts.lectureId, note.attach.id), eq(concepts.examId, examId)))
    .orderBy(asc(concepts.position), asc(concepts.id))
    .limit(1);
  return row?.id ?? null;
}

export async function addCardsFromNote(noteId: unknown, input: unknown, examId?: unknown): Promise<AddCardsResult> {
  const id = z.uuid().safeParse(noteId);
  const rows = Cards.safeParse(input);
  const exam = z.uuid().optional().safeParse(examId ?? undefined);
  if (!id.success || !rows.success || !exam.success) return { ok: false, reason: "invalid" };
  const userId = await userIdOrNull();
  if (!userId) return { ok: false, reason: "signed_out" };

  const note = await getNote(userId, id.data, db);
  if (!note) return { ok: false, reason: "not_found" };
  const usable = usableCards(rows.data);
  if (usable.length === 0) return { ok: false, reason: "empty" };

  const now = new Date();
  const target = await targetExam(userId, note, exam.data, now);
  if (target === "no_exam" || target === "choose_exam") return { ok: false, reason: target };

  const [source, conceptId] = await Promise.all([sourceLabel(userId, note), lectureConcept(note, target.id)]);

  // One card per content hash, in her order; a repeat inside the batch counts as skipped.
  const planned = new Map<string, { q: string; a: string }>();
  for (const r of usable) {
    const card: BasicCard = { type: "basic", q: r.front, a: r.back, concepts: [], boss: false, source };
    const hash = contentHash(card);
    if (!planned.has(hash)) planned.set(hash, { q: card.q, a: card.a });
  }
  const hashes = [...planned.keys()];

  const added = await db.transaction(async (tx) => {
    const have = await tx
      .select({ hash: cards.contentHash })
      .from(cards)
      .where(and(eq(cards.userId, userId), inArray(cards.contentHash, hashes)));
    const known = new Set(have.map((h) => h.hash));
    const fresh = hashes.filter((h) => !known.has(h));
    if (fresh.length === 0) return 0;
    const made = await tx
      .insert(cards)
      .values(
        fresh.map((hash) => ({
          userId,
          examId: target.id,
          type: "basic" as const,
          body: planned.get(hash)!,
          source,
          origin: "note" as const,
          contentHash: hash,
        })),
      )
      // A card stored by another tab between the read and here is still skipped.
      .onConflictDoNothing({ target: [cards.userId, cards.contentHash] })
      .returning({ id: cards.id });
    if (made.length === 0) return 0;
    if (conceptId) await tx.insert(cardConcepts).values(made.map((c) => ({ cardId: c.id, conceptId })));
    const memory = newCard(now);
    await tx.insert(cardStates).values(made.map((c) => ({ cardId: c.id, fsrs: memory, dueAt: now, lapses: 0 })));
    return made.length;
  });

  if (added > 0) refresh();
  return { ok: true, added, skipped: usable.length - added, course: shortNameOf(target.courseName) };
}

export async function noteCardExams(): Promise<ExamChoicesResult> {
  const userId = await userIdOrNull();
  if (!userId) return { ok: false, reason: "signed_out" };
  const list = await upcomingExams(userId, new Date());
  return {
    ok: true,
    exams: list.map((e) => ({ id: e.id, label: `${e.title} · ${shortNameOf(e.courseName)}` })),
  };
}

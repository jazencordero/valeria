/*
 * Mock exams, server side. Every function takes the signed-in user's id and only ever touches
 * that user's rows. Types: src/lib/mock-exams/types.ts.
 *
 * Rules the screens can rely on:
 * - Keys, model answers, ticks and lecture links never leave the server before the attempt is
 *   finished: an open attempt comes with the paper only (`AttemptView.finished === false`).
 * - One open attempt per exam. `startAttempt` returns the open one if there is one; after a
 *   finished attempt it creates a new one with the true/false order reshuffled. Finished attempts
 *   are never overwritten or deleted.
 * - Scores are computed here from the stored answers and ticks, never taken from the browser.
 * - `setTicks` is allowed only after finishing. A change by her marks the attempt "edited"; her
 *   ticks replace the part's ticks, so they always win over suggested ones.
 * - A function given an exam or attempt that is not this user's returns null (or throws
 *   `MockExamNotFound` where it must return a value).
 *
 * How it is kept (src/server/db/schema/study.ts: `mock_exams`, `mock_exam_attempts`):
 * - Every query carries `user_id = userId`. The database handle is the last argument and
 *   defaults to the app's `db`, as in the sibling modules.
 * - `saveAnswer` writes one key of one jsonb column in a single UPDATE (`texts || {key: text}`),
 *   so two saves for different parts that race both land.
 * - `finishAttempt` and `setTicks` lock the attempt's row, so the stored score always belongs
 *   to the stored answers and ticks.
 * - A partial unique index allows one open attempt per exam, also when two starts race.
 * - A new upload of her bundle updates an exam's content in place. Attempts point at item
 *   indexes, part keys and tick indexes: the stored score of a finished attempt is kept as it
 *   was; only `setTicks` scores it again, against the content of that moment (a tick index or a
 *   part the content no longer has then counts for nothing).
 * - `setTicks` throws `MockExamNotFound` also for an attempt that is not finished yet and for a
 *   part the exam does not have.
 * - Lecture links (`LectureRef.href`) are worked out when a finished view is read, from the
 *   lecture numbers the import kept beside the content; they are never stored in it.
 */
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { findPart, scoreAttempt, toPaper, trueFalseOf } from "@/lib/mock-exams/score";
import type {
  AnswerInput,
  Attempt,
  AttemptScore,
  AttemptSummary,
  AttemptView,
  GivenTick,
  LectureRef,
  MockExam,
  MockExamListing,
  MockExamStart,
  PartKey,
  TickSuggestion,
} from "@/lib/mock-exams/types";
import { db as defaultDb, type Db } from "@/server/db/client";
import { lectures } from "@/server/db/schema/learn";
import { mockExamAttempts, mockExams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { mayUseFiles } from "@/server/ai/consent";
import { tutorEnabled } from "@/server/tutor/context";
import { suggestTicksForPart } from "./suggest-ticks";

export class MockExamNotFound extends Error {
  constructor() {
    super("mock exam or attempt not found");
    this.name = "MockExamNotFound";
  }
}

/** The longest text answer kept for one part. */
export const TEXT_ANSWER_MAX = 20_000;
/** The most the timer may say: a week. */
const SECONDS_MAX = 7 * 24 * 60 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ExamRow = typeof mockExams.$inferSelect;
type AttemptRow = typeof mockExamAttempts.$inferSelect;

const contentOf = (row: ExamRow) => row.content as MockExam;

function toAttempt(row: AttemptRow, examId: string): Attempt {
  return {
    id: row.id,
    examId,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    secondsUsed: row.secondsUsed,
    tfOrder: row.tfOrder,
    trueFalse: row.trueFalse,
    texts: row.texts,
    ticks: row.ticks,
    edited: row.edited,
    score: (row.score as AttemptScore | null) ?? null,
  };
}

/** The seconds the screen reported, as a whole number in range; undefined when it gave none (or nonsense). */
function secondsOf(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(SECONDS_MAX, Math.max(0, Math.floor(value)));
}

async function examRowOf(database: Db, userId: string, examId: string): Promise<ExamRow | null> {
  if (typeof examId !== "string" || !examId) return null;
  const [row] = await database
    .select()
    .from(mockExams)
    .where(and(eq(mockExams.userId, userId), eq(mockExams.importId, examId)))
    .limit(1);
  return row ?? null;
}

/** An attempt of hers with its exam, or null. `lock` holds the attempt's row until the transaction ends. */
async function attemptRowOf(database: Db, userId: string, attemptId: string, lock = false): Promise<{ attempt: AttemptRow; exam: ExamRow } | null> {
  if (typeof attemptId !== "string" || !UUID.test(attemptId)) return null;
  const query = database
    .select()
    .from(mockExamAttempts)
    .where(and(eq(mockExamAttempts.id, attemptId), eq(mockExamAttempts.userId, userId)))
    .limit(1);
  const [attempt] = lock ? await query.for("update") : await query;
  if (!attempt) return null;
  const [exam] = await database
    .select()
    .from(mockExams)
    .where(and(eq(mockExams.id, attempt.mockExamId), eq(mockExams.userId, userId)))
    .limit(1);
  return exam ? { attempt, exam } : null;
}

/**
 * True when "Check my answer" may be offered: the same three conditions the checker itself
 * requires (`suggestTicksForPart`), so the button is not shown when every click would come back
 * unavailable: her tutor is on, the course's AI study rule allows it, and her files switch is on.
 */
async function checkAllowedFor(database: Db, userId: string, courseId: string): Promise<boolean> {
  const [user] = await database.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !tutorEnabled(user.settings)) return false;
  return mayUseFiles(userId, courseId, database);
}

/** The whole exam with each lecture link's `href` filled where she has that lecture. A copy: the row is not touched. */
async function withLectureLinks(database: Db, userId: string, row: ExamRow): Promise<MockExam> {
  const exam = structuredClone(contentOf(row));
  const pages = row.lecturePages ?? {};
  const hers = Object.keys(pages).length
    ? await database
        .select({ n: lectures.n })
        .from(lectures)
        .where(and(eq(lectures.userId, userId), eq(lectures.courseId, row.courseId)))
    : [];
  const numbers = new Set(hers.map((l) => l.n));
  const link = (refs: LectureRef[] | undefined) => {
    for (const ref of refs ?? []) {
      delete ref.href; // never from the file
      const n = Object.prototype.hasOwnProperty.call(pages, ref.page) ? pages[ref.page] : undefined;
      if (typeof n === "number" && numbers.has(n)) ref.href = `/courses/${row.courseId}/lectures/${n}`;
    }
  };
  for (const q of exam.questions) {
    if (q.type === "truefalse") for (const item of q.items) link(item.lectures);
    else for (const section of q.sections) for (const part of section.parts) link(part.lectures);
  }
  return exam;
}

async function viewOf(database: Db, userId: string, attempt: AttemptRow, exam: ExamRow): Promise<AttemptView> {
  const checkAllowed = await checkAllowedFor(database, userId, exam.courseId);
  const mine = toAttempt(attempt, exam.importId);
  if (attempt.finishedAt) return { finished: true, attempt: mine, exam: await withLectureLinks(database, userId, exam), checkAllowed };
  return { finished: false, attempt: mine, exam: toPaper(contentOf(exam)), checkAllowed };
}

function listingOf(row: ExamRow, attempts: AttemptRow[]): MockExamListing {
  const exam = contentOf(row);
  const open = attempts.find((a) => !a.finishedAt) ?? null;
  const finished = attempts
    .filter((a) => a.finishedAt)
    .sort((a, b) => a.finishedAt!.getTime() - b.finishedAt!.getTime() || a.startedAt.getTime() - b.startedAt.getTime());
  const totals = finished.map((a) => a.total ?? (a.score as AttemptScore | null)?.total ?? 0);
  return {
    id: row.importId,
    order: exam.order,
    kind: exam.kind,
    title: exam.title,
    subtitle: exam.subtitle,
    totalPoints: exam.totalPoints,
    suggestedMinutes: exam.suggestedMinutes,
    ...(exam.expectedScore ? { expectedScore: exam.expectedScore } : {}),
    status: open ? "open" : finished.length ? "done" : "new",
    best: totals.length ? Math.max(...totals) : null,
    latest: totals.length ? totals[totals.length - 1] : null,
    attempts: finished.length,
    openAttemptId: open?.id ?? null,
  };
}

/** Her mock exams in paper order (boss last), each with status, best, latest and attempt count. */
export async function listMockExams(userId: string, database: Db = defaultDb): Promise<MockExamListing[]> {
  const rows = await database.select().from(mockExams).where(eq(mockExams.userId, userId));
  if (!rows.length) return [];
  const attempts = await database.select().from(mockExamAttempts).where(eq(mockExamAttempts.userId, userId));
  return rows
    .map((row) => listingOf(row, attempts.filter((a) => a.mockExamId === row.id)))
    .sort((a, b) => Number(a.kind === "boss") - Number(b.kind === "boss") || a.order - b.order || a.id.localeCompare(b.id));
}

/** The start screen of one exam (the paper, no keys), or null when she has no such exam. */
export async function getMockExam(userId: string, examId: string, database: Db = defaultDb): Promise<MockExamStart | null> {
  const row = await examRowOf(database, userId, examId);
  if (!row) return null;
  const attempts = await database
    .select()
    .from(mockExamAttempts)
    .where(and(eq(mockExamAttempts.userId, userId), eq(mockExamAttempts.mockExamId, row.id)));
  return { exam: toPaper(contentOf(row)), listing: listingOf(row, attempts), checkAllowed: await checkAllowedFor(database, userId, row.courseId) };
}

/** 0..n-1 in a random order; not `avoid`'s order when there is more than one item. */
export function shuffledOrder(n: number, avoid?: readonly number[], random: () => number = Math.random): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  if (n < 2) return order;
  const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  for (let tries = 0; tries < 20; tries++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.min(i, Math.floor(random() * (i + 1)));
      [order[i], order[j]] = [order[j], order[i]];
    }
    if (!avoid || !same(order, avoid)) return order;
  }
  // Twenty times the same order: turn it by one, which is always another order.
  return [...order.slice(1), order[0]];
}

async function openAttemptRow(database: Db, userId: string, mockExamId: string): Promise<AttemptRow | null> {
  const [row] = await database
    .select()
    .from(mockExamAttempts)
    .where(and(eq(mockExamAttempts.userId, userId), eq(mockExamAttempts.mockExamId, mockExamId), isNull(mockExamAttempts.finishedAt)))
    .limit(1);
  return row ?? null;
}

/** Starts an attempt, or returns the open one. A new attempt after a finished one reshuffles true/false. */
export async function startAttempt(userId: string, examId: string, database: Db = defaultDb): Promise<AttemptView> {
  const exam = await examRowOf(database, userId, examId);
  if (!exam) throw new MockExamNotFound();
  let attempt = await openAttemptRow(database, userId, exam.id);
  if (!attempt) {
    const [previous] = await database
      .select({ tfOrder: mockExamAttempts.tfOrder })
      .from(mockExamAttempts)
      .where(and(eq(mockExamAttempts.userId, userId), eq(mockExamAttempts.mockExamId, exam.id)))
      .orderBy(desc(mockExamAttempts.startedAt), desc(mockExamAttempts.createdAt))
      .limit(1);
    const items = trueFalseOf(contentOf(exam))?.items.length ?? 0;
    // Two starts at once: the index on open attempts lets one in; the other finds that one below.
    await database
      .insert(mockExamAttempts)
      .values({ userId, mockExamId: exam.id, tfOrder: shuffledOrder(items, previous?.tfOrder) })
      .onConflictDoNothing();
    attempt = await openAttemptRow(database, userId, exam.id);
    if (!attempt) throw new MockExamNotFound();
  }
  return viewOf(database, userId, attempt, exam);
}

/** The unfinished attempt of an exam, to resume; null when there is none. */
export async function getOpenAttempt(userId: string, examId: string, database: Db = defaultDb): Promise<AttemptView | null> {
  const exam = await examRowOf(database, userId, examId);
  if (!exam) return null;
  const attempt = await openAttemptRow(database, userId, exam.id);
  return attempt ? viewOf(database, userId, attempt, exam) : null;
}

/**
 * Saves one answer of an open attempt: a text for a part, or true / false / blank for an item.
 * `secondsUsed`, when given, updates the timer. Returns false when the attempt is finished or
 * not hers (nothing saved). Also false for an item or part the exam does not have, and for an
 * answer of the wrong kind. A text longer than `TEXT_ANSWER_MAX` is cut to that length.
 */
export async function saveAnswer(
  userId: string,
  attemptId: string,
  answer: AnswerInput,
  secondsUsed?: number,
  database: Db = defaultDb,
): Promise<boolean> {
  const found = await attemptRowOf(database, userId, attemptId);
  if (!found || found.attempt.finishedAt) return false;
  const exam = contentOf(found.exam);
  const seconds = secondsOf(secondsUsed);
  const timer = seconds === undefined ? {} : { secondsUsed: seconds };

  let set: Partial<Record<"trueFalse" | "texts", ReturnType<typeof sql>>>;
  if (answer?.kind === "trueFalse") {
    const items = trueFalseOf(exam)?.items.length ?? 0;
    if (!Number.isInteger(answer.item) || answer.item < 0 || answer.item >= items) return false;
    if (answer.answer !== true && answer.answer !== false && answer.answer !== null) return false;
    const one = JSON.stringify({ [String(answer.item)]: answer.answer });
    set = { trueFalse: sql`${mockExamAttempts.trueFalse} || ${one}::jsonb` };
  } else if (answer?.kind === "text") {
    if (typeof answer.part !== "string" || typeof answer.text !== "string" || !findPart(exam, answer.part)) return false;
    const one = JSON.stringify({ [answer.part]: answer.text.slice(0, TEXT_ANSWER_MAX) });
    set = { texts: sql`${mockExamAttempts.texts} || ${one}::jsonb` };
  } else return false;

  // One statement: the key is merged into the row as it is when the row is written, so a save
  // for another part made in the meantime is kept. Finished in the meantime: no row, false.
  const saved = await database
    .update(mockExamAttempts)
    .set({ ...set, ...timer })
    .where(and(eq(mockExamAttempts.id, found.attempt.id), eq(mockExamAttempts.userId, userId), isNull(mockExamAttempts.finishedAt)))
    .returning({ id: mockExamAttempts.id });
  return saved.length === 1;
}

/** Finishes an open attempt and scores it (question 1 only, until she ticks). Returns it with the keys. */
export async function finishAttempt(userId: string, attemptId: string, secondsUsed?: number, database: Db = defaultDb): Promise<AttemptView> {
  const done = await database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const found = await attemptRowOf(tx, userId, attemptId, true);
    if (!found) return null;
    // Finished already: the same attempt again, nothing changed (not the time, not the score).
    if (found.attempt.finishedAt) return found;
    const score = scoreAttempt(contentOf(found.exam), { trueFalse: found.attempt.trueFalse, ticks: found.attempt.ticks });
    const seconds = secondsOf(secondsUsed);
    const [attempt] = await tx
      .update(mockExamAttempts)
      .set({ finishedAt: new Date(), score, total: score.total, ...(seconds === undefined ? {} : { secondsUsed: seconds }) })
      .where(and(eq(mockExamAttempts.id, found.attempt.id), eq(mockExamAttempts.userId, userId)))
      .returning();
    return { attempt, exam: found.exam };
  });
  if (!done) throw new MockExamNotFound();
  return viewOf(database, userId, done.attempt, done.exam);
}

/**
 * Replaces the ticks of one part of a finished attempt and rescores it. `fromCheck` on a tick
 * says it was taken from "Check my answer". Marks the attempt edited when `edit` is true (a
 * change made after the first marking pass). Returns the attempt with its new score.
 */
export async function setTicks(
  userId: string,
  attemptId: string,
  part: PartKey,
  ticks: GivenTick[],
  edit?: boolean,
  database: Db = defaultDb,
): Promise<Attempt> {
  const saved = await database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const found = await attemptRowOf(tx, userId, attemptId, true);
    if (!found || !found.attempt.finishedAt) return null;
    const exam = contentOf(found.exam);
    const thePart = typeof part === "string" ? findPart(exam, part) : null;
    if (!thePart) return null;
    // Each tick of the part once, in the order given; anything else is dropped.
    const kept: GivenTick[] = [];
    for (const t of Array.isArray(ticks) ? ticks : []) {
      const index = t?.index;
      if (!Number.isInteger(index) || index < 0 || index >= thePart.ticks.length || kept.some((k) => k.index === index)) continue;
      kept.push({ index, fromCheck: t.fromCheck === true });
    }
    const all = { ...found.attempt.ticks, [part]: kept };
    const score = scoreAttempt(exam, { trueFalse: found.attempt.trueFalse, ticks: all });
    const [attempt] = await tx
      .update(mockExamAttempts)
      .set({ ticks: all, score, total: score.total, edited: found.attempt.edited || edit === true })
      .where(and(eq(mockExamAttempts.id, found.attempt.id), eq(mockExamAttempts.userId, userId)))
      .returning();
    return toAttempt(attempt, found.exam.importId);
  });
  if (!saved) throw new MockExamNotFound();
  return saved;
}

/** Finished attempts, oldest first: of one exam (its history), or of all (the overall trend). */
export async function listAttempts(userId: string, examId?: string, database: Db = defaultDb): Promise<AttemptSummary[]> {
  const rows = await database
    .select({ attempt: mockExamAttempts, importId: mockExams.importId, content: mockExams.content })
    .from(mockExamAttempts)
    .innerJoin(mockExams, eq(mockExams.id, mockExamAttempts.mockExamId))
    .where(
      and(
        eq(mockExamAttempts.userId, userId),
        eq(mockExams.userId, userId),
        isNotNull(mockExamAttempts.finishedAt),
        ...(examId === undefined ? [] : [eq(mockExams.importId, String(examId))]),
      ),
    )
    .orderBy(asc(mockExamAttempts.finishedAt), asc(mockExamAttempts.startedAt), asc(mockExamAttempts.id));
  return rows.flatMap(({ attempt, importId, content }) => {
    const score = attempt.score as AttemptScore | null;
    if (!attempt.finishedAt || !score) return [];
    return [
      {
        id: attempt.id,
        examId: importId,
        examTitle: (content as MockExam).title,
        startedAt: attempt.startedAt.toISOString(),
        finishedAt: attempt.finishedAt.toISOString(),
        secondsUsed: attempt.secondsUsed,
        edited: attempt.edited,
        score,
      },
    ];
  });
}

/** One attempt with the exam as she may see it; null when it is not hers. */
export async function getAttempt(userId: string, attemptId: string, database: Db = defaultDb): Promise<AttemptView | null> {
  const found = await attemptRowOf(database, userId, attemptId);
  return found ? viewOf(database, userId, found.attempt, found.exam) : null;
}

/**
 * "Check my answer" for one part of a finished attempt: suggested ticks and two lines on what
 * was missing. "unavailable" when the course's AI study rule does not allow it, the budget is
 * spent or the model is down; the screen then offers self-marking only and shows no error.
 * Suggests only: nothing is stored until the screen calls `setTicks`.
 * The checking itself (tutor switch, course rule, budget, the model) is `suggestTicksForPart`.
 */
export async function suggestTicks(
  userId: string,
  attemptId: string,
  part: PartKey,
  database: Db = defaultDb,
): Promise<TickSuggestion> {
  try {
    const found = await attemptRowOf(database, userId, attemptId);
    if (!found || found.attempt.finishedAt === null) return { status: "unavailable" };
    const exam = found.exam.content as MockExam;
    const written = findPart(exam, part);
    if (!written) return { status: "unavailable" };
    const [q, s] = part.split(".").map(Number);
    const question = exam.questions.find((x) => x.number === q);
    const stem = question?.type === "written" ? question.sections[s]?.stem : undefined;
    const texts = (found.attempt.texts ?? {}) as Record<string, string>;
    const result = await suggestTicksForPart(userId, found.exam.courseId, written, texts[part] ?? "", { stem, db: database });
    if (result.status !== "ok") return { status: "unavailable" };
    return { status: "ok", part, ticks: result.ticks, missing: result.missing };
  } catch {
    return { status: "unavailable" };
  }
}

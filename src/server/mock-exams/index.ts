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
 */
import type {
  AnswerInput,
  Attempt,
  AttemptSummary,
  AttemptView,
  GivenTick,
  MockExamListing,
  MockExamStart,
  PartKey,
  TickSuggestion,
} from "@/lib/mock-exams/types";

export class MockExamNotFound extends Error {
  constructor() {
    super("mock exam or attempt not found");
    this.name = "MockExamNotFound";
  }
}

/** Her mock exams in paper order (boss last), each with status, best, latest and attempt count. */
export async function listMockExams(userId: string): Promise<MockExamListing[]> {
  void userId;
  return [];
}

/** The start screen of one exam (the paper, no keys), or null when she has no such exam. */
export async function getMockExam(userId: string, examId: string): Promise<MockExamStart | null> {
  void userId;
  void examId;
  return null;
}

/** Starts an attempt, or returns the open one. A new attempt after a finished one reshuffles true/false. */
export async function startAttempt(userId: string, examId: string): Promise<AttemptView> {
  void userId;
  void examId;
  throw new MockExamNotFound();
}

/** The unfinished attempt of an exam, to resume; null when there is none. */
export async function getOpenAttempt(userId: string, examId: string): Promise<AttemptView | null> {
  void userId;
  void examId;
  return null;
}

/**
 * Saves one answer of an open attempt: a text for a part, or true / false / blank for an item.
 * `secondsUsed`, when given, updates the timer. Returns false when the attempt is finished or
 * not hers (nothing saved).
 */
export async function saveAnswer(
  userId: string,
  attemptId: string,
  answer: AnswerInput,
  secondsUsed?: number,
): Promise<boolean> {
  void userId;
  void attemptId;
  void answer;
  void secondsUsed;
  return false;
}

/** Finishes an open attempt and scores it (question 1 only, until she ticks). Returns it with the keys. */
export async function finishAttempt(userId: string, attemptId: string, secondsUsed?: number): Promise<AttemptView> {
  void userId;
  void attemptId;
  void secondsUsed;
  throw new MockExamNotFound();
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
): Promise<Attempt> {
  void userId;
  void attemptId;
  void part;
  void ticks;
  void edit;
  throw new MockExamNotFound();
}

/** Finished attempts, oldest first: of one exam (its history), or of all (the overall trend). */
export async function listAttempts(userId: string, examId?: string): Promise<AttemptSummary[]> {
  void userId;
  void examId;
  return [];
}

/** One attempt with the exam as she may see it; null when it is not hers. */
export async function getAttempt(userId: string, attemptId: string): Promise<AttemptView | null> {
  void userId;
  void attemptId;
  return null;
}

/**
 * "Check my answer" for one part of a finished attempt: suggested ticks and two lines on what
 * was missing. "unavailable" when the course's AI study rule does not allow it, the budget is
 * spent or the model is down; the screen then offers self-marking only and shows no error.
 * Suggests only: nothing is stored until the screen calls `setTicks`.
 */
export async function suggestTicks(userId: string, attemptId: string, part: PartKey): Promise<TickSuggestion> {
  void userId;
  void attemptId;
  void part;
  return { status: "unavailable" };
}

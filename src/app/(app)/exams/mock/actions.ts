"use server";
/*
 * Mock exams (M3-60): the Server Actions the screens call. Each one finds the signed-in user
 * first and passes only her id to src/server/mock-exams, which touches only her rows; none takes
 * a user id, so the file-level directive exposes nothing that could act for someone else.
 */
import { redirect } from "next/navigation";
import type { AnswerInput, Attempt, AttemptView, GivenTick, PartKey, TickSuggestion } from "@/lib/mock-exams/types";
import { currentUser } from "@/server/auth/session";
import {
  finishAttempt,
  saveAnswer,
  setTicks,
  startAttempt,
  suggestTicks,
} from "@/server/mock-exams";

/** Starts an attempt (or finds the open one) and goes to its first question. */
export async function startMockExamAction(examId: string): Promise<void> {
  const user = await currentUser();
  const view = await startAttempt(user.id, examId);
  redirect(`/exams/mock/attempt/${view.attempt.id}`);
}

export async function saveMockAnswerAction(
  attemptId: string,
  answer: AnswerInput,
  secondsUsed?: number,
): Promise<boolean> {
  const user = await currentUser();
  return saveAnswer(user.id, attemptId, answer, secondsUsed);
}

export async function finishMockAttemptAction(attemptId: string, secondsUsed?: number): Promise<AttemptView> {
  const user = await currentUser();
  return finishAttempt(user.id, attemptId, secondsUsed);
}

export async function setMockTicksAction(
  attemptId: string,
  part: PartKey,
  ticks: GivenTick[],
  edit: boolean,
): Promise<Attempt> {
  const user = await currentUser();
  return setTicks(user.id, attemptId, part, ticks, edit);
}

export async function suggestMockTicksAction(attemptId: string, part: PartKey): Promise<TickSuggestion> {
  try {
    const user = await currentUser();
    return await suggestTicks(user.id, attemptId, part);
  } catch {
    // Self-marking only, no error shown.
    return { status: "unavailable" };
  }
}

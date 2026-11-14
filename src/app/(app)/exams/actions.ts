/*
 * Exam form actions (M3-13): add or correct an exam, remove one.
 *
 * Same shape as settings/actions.ts (M1-38): the work sits in plain
 * functions that take a `Db` and a user id, and the Server Actions are thin
 * wrappers that find the signed-in user first. There is no file-level
 * "use server" on purpose: that would make `saveExamFor` and `removeExamFor`,
 * which take any user id, callable endpoints. Only the `...Action` functions
 * carry the directive. Client components cannot import those directly; a
 * server page passes them to `ExamForm` as props.
 */
import { revalidatePath } from "next/cache";
import type { ExamFormState } from "@/components/exams/exam-form";
import { currentUser, NotSignedIn, type User } from "@/server/auth/session";
import { db as defaultDb, type Db } from "@/server/db/client";
import {
  addExam,
  ExamInvalid,
  ExamNotFound,
  parseExamForm,
  removeExam,
  updateExam,
  type ExamFormFields,
} from "@/server/study/exams";

const FIELDS = ["courseId", "title", "kind", "date", "time", "targetGrade"] as const;

function fieldsOf(formData: FormData): Partial<ExamFormFields> {
  const out: Partial<ExamFormFields> = {};
  for (const name of FIELDS) {
    const v = formData.get(name);
    if (typeof v === "string") out[name] = v;
  }
  return out;
}

/**
 * Adds an exam, or updates the one named by the form's `examId` field.
 * Returns the form's next state; never throws for her mistakes or for ids
 * that are not hers.
 */
export async function saveExamFor(database: Db, userId: string, formData: FormData): Promise<ExamFormState> {
  const parsed = parseExamForm(fieldsOf(formData));
  if (!parsed.ok) return { status: "error", errors: parsed.errors };
  const examId = formData.get("examId");
  try {
    const exam =
      typeof examId === "string" && examId !== ""
        ? await updateExam(userId, examId, parsed.input, database)
        : await addExam(userId, parsed.input, database);
    return { status: "saved", examId: exam.id };
  } catch (err) {
    if (err instanceof ExamInvalid) return { status: "error", errors: err.fields };
    if (err instanceof ExamNotFound) {
      return { status: "error", errors: {}, message: "That exam or course is not in your list any more." };
    }
    throw err;
  }
}

export type RemoveExamResult = { ok: true } | { ok: false; message: string };

export async function removeExamFor(database: Db, userId: string, examId: string): Promise<RemoveExamResult> {
  try {
    await removeExam(userId, examId, database);
    return { ok: true };
  } catch (err) {
    if (err instanceof ExamNotFound) return { ok: false, message: "That exam is not in your list any more." };
    throw err;
  }
}

async function signedInUser(): Promise<User | null> {
  try {
    return await currentUser();
  } catch (err) {
    if (err instanceof NotSignedIn) return null;
    throw err;
  }
}

const SIGNED_OUT = "You are signed out. Reload the page and try again.";

/** `useActionState` action for the exam form. */
export async function saveExamAction(_prev: ExamFormState, formData: FormData): Promise<ExamFormState> {
  "use server";
  const user = await signedInUser();
  if (!user) return { status: "error", errors: {}, message: SIGNED_OUT };
  const state = await saveExamFor(defaultDb, user.id, formData);
  if (state.status === "saved") revalidatePath("/exams", "layout");
  return state;
}

/** Removes one of her exams. */
export async function removeExamAction(examId: string): Promise<RemoveExamResult> {
  "use server";
  const user = await signedInUser();
  if (!user) return { ok: false, message: SIGNED_OUT };
  const result = await removeExamFor(defaultDb, user.id, examId);
  if (result.ok) revalidatePath("/exams", "layout");
  return result;
}

/**
 * One mock exam attempt (M3-60): `/exams/mock/attempt/<attemptId>`.
 * - Open: she sits it (`Sitting`), question from ?q= (else where she was last in this browser).
 * - Finished: ?view=mark shows the marking screens (question from ?q=), otherwise the result.
 * - A finished attempt that is not the newest of its exam opens read-only (a past attempt): the
 *   result and the marking screens with fixed ticks.
 * Not hers, unknown or malformed: a 404. It all depends on the cookie: Suspense.
 */
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { Marking } from "@/components/mock-exams/marking";
import { Result } from "@/components/mock-exams/result";
import { Sitting } from "@/components/mock-exams/sitting";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { getAttempt, listAttempts } from "@/server/mock-exams";

type Params = Promise<{ attemptId: string }>;
type Search = Promise<{ q?: string; view?: string }>;

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

function questionOf(v: string | undefined): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}

async function AttemptScreen({ params, searchParams }: { params: Params; searchParams: Search }) {
  const [{ attemptId }, sp] = await Promise.all([params, searchParams]);
  await connection();
  const user = await signedInUser();
  const view = await getAttempt(user.id, attemptId);
  if (!view) notFound();
  const q = questionOf(sp.q);
  if (!view.finished) return <Sitting key={view.attempt.id} exam={view.exam} attempt={view.attempt} initialQ={q} />;

  const history = await listAttempts(user.id, view.attempt.examId);
  const newest = history.at(-1);
  const readOnly = !!newest && newest.id !== view.attempt.id;
  if (sp.view === "mark") {
    return (
      <Marking
        key={view.attempt.id}
        exam={view.exam}
        attempt={view.attempt}
        checkAllowed={view.checkAllowed}
        initialQ={q ?? 1}
        readOnly={readOnly}
      />
    );
  }
  return <Result exam={view.exam} attempt={view.attempt} />;
}

export default function MockAttemptRoute({ params, searchParams }: { params: Params; searchParams: Search }) {
  return (
    <Suspense fallback={null}>
      <AttemptScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}

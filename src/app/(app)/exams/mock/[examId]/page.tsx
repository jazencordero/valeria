/**
 * One mock exam (M3-60): `/exams/mock/<examId>`, the start screen and her attempt history.
 * The exam id is the bundle's (e.g. "mock-1"). An exam she does not have is a 404.
 * Everything depends on the cookie, so it streams inside Suspense (cacheComponents).
 */
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { StartScreen } from "@/components/mock-exams/start-screen";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { getMockExam, listAttempts } from "@/server/mock-exams";

type Params = Promise<{ examId: string }>;

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

async function Exam({ params }: { params: Params }) {
  const { examId } = await params;
  await connection();
  const user = await signedInUser();
  const [start, history] = await Promise.all([getMockExam(user.id, examId), listAttempts(user.id, examId)]);
  if (!start) notFound();
  return <StartScreen start={start} history={history} />;
}

export default function MockExamRoute({ params }: { params: Params }) {
  return (
    <Suspense fallback={null}>
      <Exam params={params} />
    </Suspense>
  );
}

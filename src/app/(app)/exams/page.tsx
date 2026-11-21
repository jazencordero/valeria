/**
 * Exams tab (M3-41): one card per upcoming exam or quiz, soonest first, and
 * "Add an exam". Past exams are hidden (no archive).
 * Source: prototype merged-2.html HTML 1866-1872 (#tab-exams: h1, .page-sub,
 * .exam-cards.stack), JS 3238-3248 (examTabCard) and CSS 448, 756-769 (.page,
 * .page-sub, .empty, .exam-cards.stack). The button and the empty line are
 * not in the prototype; the sentences are the ticket's.
 *
 * The heading ships in the static shell; her cards depend on the cookie and
 * the clock, so they stream inside Suspense.
 *
 * Mock exams (M3-60): when her bundle has mock exams, the page gets two tabs, "Exams and
 * quizzes" (the cards as before) and "Mock exams" (the trend and the five exams). The chosen tab
 * is remembered for the visit, so coming back from a mock exam lands on it.
 *
 * `AddExam` (a client component) holds the form sheet's open state; this page
 * hands it her courses and `saveExamAction`, which revalidates /exams, so the
 * new card is there when the sheet has closed.
 */
import { connection } from "next/server";
import { Suspense } from "react";
import { AddExam } from "@/components/exams/add-exam";
import { ExamTabCard } from "@/components/exams/exam-tab-card";
import { MockList } from "@/components/mock-exams/mock-list";
import { Tabs } from "@/components/ui/tabs";
import { lmsNameOf } from "@/lib/schools";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { getExamsView } from "@/server/data/exams";
import { listAttempts, listMockExams } from "@/server/mock-exams";
import { saveExamAction } from "./actions";

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

async function ExamCards() {
  await connection();
  const user = await signedInUser();
  const [view, mocks, attempts] = await Promise.all([
    getExamsView(user.id, { now: new Date() }),
    listMockExams(user.id),
    listAttempts(user.id),
  ]);

  const cards = (
    <>
      {view.exams.length > 0 ? (
        <ul className="mt-5 grid list-none gap-3.5">
          {view.exams.map((exam) => (
            <li key={exam.id}>
              <ExamTabCard
                href={exam.href}
                phase={exam.phase}
                title={exam.title}
                course={exam.course}
                when={exam.when}
                forecast={exam.forecast}
                spark={exam.spark}
                target={exam.target}
                concepts={exam.concepts}
                counts={exam.counts}
                making={exam.making}
                starts={exam.starts}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-5 py-3 text-[13px] text-ink-3">
          No exams yet. Add one, or they appear when {lmsNameOf(user)} lists them.
        </p>
      )}

      <div className="mt-5">
        <AddExam courses={view.courses} action={saveExamAction} />
      </div>
    </>
  );

  if (mocks.length === 0) return cards;
  return (
    <Tabs
      className="mt-5"
      label="Exams sections"
      memoryKey="exams"
      tabs={[
        { id: "exams", label: "Exams and quizzes", content: cards },
        { id: "mock", label: "Mock exams", count: mocks.length, content: <MockList exams={mocks} attempts={attempts} /> },
      ]}
    />
  );
}

export default function ExamsPage() {
  return (
    <div className="mx-auto max-w-[720px] px-[var(--pad)] pt-[max(20px,env(safe-area-inset-top,0px))] pb-10">
      <h1 className="type-h30" tabIndex={-1}>
        Exams and quizzes
      </h1>
      <p className="mt-1.5 text-[15px] text-ink-2">What is coming and how long until you are ready.</p>
      <Suspense fallback={null}>
        <ExamCards />
      </Suspense>
    </div>
  );
}

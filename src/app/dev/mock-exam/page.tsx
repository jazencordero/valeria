/**
 * Preview of the mock exam screens (M3-60) with the invented sample exam:
 * /dev/mock-exam?view=list|start|sit|mark|result&q=1..4. Saving goes to the real actions, which
 * find no attempt here, so the bar says "Not saved, retrying" while sitting: that is expected.
 */
import { Suspense } from "react";
import { Marking } from "@/components/mock-exams/marking";
import { MockList } from "@/components/mock-exams/mock-list";
import { Result } from "@/components/mock-exams/result";
import { sampleAttempt, sampleExam, samplePaper } from "@/components/mock-exams/sample-exam";
import { Sitting } from "@/components/mock-exams/sitting";
import { StartScreen } from "@/components/mock-exams/start-screen";
import type { AttemptSummary, MockExamListing } from "@/lib/mock-exams/types";

type Search = Promise<{ view?: string; q?: string }>;

const done = sampleAttempt({
  finishedAt: "2026-11-21T09:00:00.000Z",
  secondsUsed: 2950,
  trueFalse: { 0: true, 1: true, 2: null, 3: false, 4: true, 5: false },
  texts: { "2.0.0": "It is the idea, because it matters.", "3.0.0": "3" },
  ticks: { "2.0.0": [{ index: 0, fromCheck: false }, { index: 1, fromCheck: true }], "3.0.0": [{ index: 0, fromCheck: false }] },
  score: null,
});

const listing = (over: Partial<MockExamListing>): MockExamListing => ({
  id: "sample-1",
  order: 1,
  kind: "teacher",
  title: "Sample exam",
  subtitle: "An invented exam for tests.",
  totalPoints: 24,
  suggestedMinutes: 60,
  status: "new",
  best: null,
  latest: null,
  attempts: 0,
  openAttemptId: null,
  ...over,
});

const history: AttemptSummary[] = [9.5, 13, 16.5].map((total, i) => ({
  id: `h${i}`,
  examId: "sample-1",
  examTitle: "Sample exam",
  startedAt: `2026-11-${19 + i}T08:00:00.000Z`,
  finishedAt: `2026-11-${19 + i}T09:00:00.000Z`,
  secondsUsed: 3000 + i * 60,
  edited: i === 1,
  score: {
    total,
    max: 24,
    questions: [1, 2, 3, 4].map((number) => ({ number, score: total / 4, max: 6 })),
  },
}));

async function View({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const q = Math.min(4, Math.max(1, Number(sp.q) || 1));
  switch (sp.view) {
    case "sit":
      return <Sitting exam={samplePaper} attempt={sampleAttempt()} initialQ={q} />;
    case "mark":
      return <Marking exam={sampleExam} attempt={done} checkAllowed initialQ={q} readOnly={false} />;
    case "result":
      return <Result exam={sampleExam} attempt={done} />;
    case "start":
      return (
        <StartScreen
          start={{ exam: { ...samplePaper, kind: "boss", expectedScore: { low: 14, high: 18 } }, listing: listing({ status: "done", attempts: 3, best: 16.5, latest: 16.5 }), checkAllowed: true }}
          history={history}
        />
      );
    default:
      return (
        <div className="mx-auto max-w-[720px] px-[var(--pad)] pt-5 pb-10">
          <h1 className="type-h30">Exams and quizzes</h1>
          <MockList
            attempts={history}
            exams={[
              listing({ status: "done", attempts: 3, best: 16.5, latest: 16.5 }),
              listing({ id: "s2", order: 2, kind: "mock", title: "Mock exam 1", status: "open", openAttemptId: "x" }),
              listing({ id: "s3", order: 3, kind: "mock", title: "Mock exam 2" }),
              listing({ id: "s4", order: 4, kind: "boss", title: "Boss exam", expectedScore: { low: 14, high: 18 } }),
            ]}
          />
        </div>
      );
  }
}

export default function MockExamPreview({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense fallback={null}>
      <View searchParams={searchParams} />
    </Suspense>
  );
}

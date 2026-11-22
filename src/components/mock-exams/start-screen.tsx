/*
 * Mock exams (M3-60): one exam's page. Its chips and title, the boss promise (a well-prepared
 * student scores 14 to 18 of 24) before she starts the boss exam, the intro and source, the
 * format line, the teacher's full "How to answer" text, the timer switch, then Start / Resume.
 * Under it the attempt history: each finished attempt with date, time used, per-question scores
 * and total, opening read-only.
 */
import Link from "next/link";
import type { AttemptSummary, MockExamStart } from "@/lib/mock-exams/types";
import { Button } from "@/components/ui/button";
import { minutesUsed, num, shortDay } from "./format";
import { MockTrend } from "./mock-list";
import { StartButton } from "./retake-button";
import { TimerSwitch } from "./timer-switch";

export function StartScreen({ start, history }: { start: MockExamStart; history: AttemptSummary[] }) {
  const { exam, listing } = start;
  const boss = exam.kind === "boss" && exam.expectedScore;
  const per = exam.questions[0]?.points ?? 0;
  const uniform = exam.questions.every((q) => q.points === per);
  const label =
    listing.status === "open" ? "Resume" : listing.attempts > 0 ? "Retake" : "Start";
  return (
    <div className="mx-auto max-w-[720px] px-[var(--pad)] pt-[max(20px,env(safe-area-inset-top,0px))] pb-10">
      <Button variant="text" href="/exams" className="-ml-1">
        ← Mock exams
      </Button>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {exam.kind === "boss" ? (
          <span className="rounded-full bg-due/15 px-2.5 py-0.5 text-[12px] text-due">Boss</span>
        ) : null}
        {exam.kind === "teacher" ? (
          <span className="rounded-full bg-butter/60 px-2.5 py-0.5 text-[12px] text-ink">From your teacher</span>
        ) : null}
      </div>
      <h1 className="type-h30 mt-2" tabIndex={-1}>
        {exam.title}
      </h1>
      <p className="mt-1.5 text-[15px] text-ink-2">{exam.subtitle}</p>

      {boss ? (
        <div className="mt-4 rounded-2xl bg-due/10 p-4" data-testid="boss-promise">
          <p className="font-display text-[28px] leading-none">
            {boss.low} to {boss.high} <small className="text-[16px] text-ink-3">of {exam.totalPoints}</small>
          </p>
          <p className="mt-2 text-[15px] text-ink">
            A well-prepared student scores {boss.low} to {boss.high} of {exam.totalPoints} here. That is the point.
          </p>
        </div>
      ) : null}

      <div className="mt-5 grid gap-3">
        {exam.intro ? <p className="text-[15px]">{exam.intro}</p> : null}
        {exam.source ? <p className="text-[13px] text-ink-3">Source: {exam.source}</p> : null}
        <p className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[13px] text-ink-2">
          <span>{exam.questions.length} questions</span>
          {uniform ? <span>{num(per)} points each</span> : null}
          <span>{exam.totalPoints} total</span>
          {exam.calculator ? <span>calculator allowed</span> : null}
        </p>
        <div className="rounded-2xl border border-line bg-surface p-4" data-testid="how-to-answer">
          <p className="font-display text-[16px] leading-[1.55]">
            <b className="font-semibold">How to answer:</b> {exam.howToAnswer}
          </p>
        </div>
        {listing.status !== "open" ? <TimerSwitch examId={exam.id} minutes={exam.suggestedMinutes} /> : null}
      </div>

      <div className="mt-6">
        {listing.status === "open" && listing.openAttemptId ? (
          <Button size="lg" block href={`/exams/mock/attempt/${listing.openAttemptId}`}>
            Resume
          </Button>
        ) : (
          <StartButton examId={exam.id} label={label} />
        )}
      </div>

      {history.length ? (
        <section className="mt-10" aria-labelledby="history-h">
          <h2 id="history-h" className="type-h22">
            Your attempts
          </h2>
          <div className="mt-3">
            <MockTrend attempts={history} kinds={{ [exam.id]: exam.kind }} title="This exam so far" />
          </div>
          <ul className="mt-3 grid list-none gap-2.5">
            {[...history].reverse().map((a) => (
              <li key={a.id}>
                <Link
                  href={`/exams/mock/attempt/${a.id}?view=result`}
                  className="block rounded-2xl border border-line bg-surface p-4 hover:border-ink-3"
                  data-testid="history-row"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-[13px] text-ink-2">
                      {shortDay(a.finishedAt)} · {minutesUsed(a.secondsUsed)}
                      {a.edited ? " · edited" : ""}
                    </span>
                    <span className="font-display text-[22px]">
                      {num(a.score.total)} <small className="text-[14px] text-ink-3">/ {a.score.max}</small>
                    </span>
                  </span>
                  <span className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[12px] text-ink-3">
                    {a.score.questions.map((q) => (
                      <span key={q.number}>
                        Q{q.number} {num(q.score)}/{num(q.max)}
                      </span>
                    ))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

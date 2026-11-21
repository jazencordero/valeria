/*
 * Mock exams (M3-60): the "Mock exams" tab of Exams. A small trend of every finished attempt
 * (score out of 24, oldest first), then one card per exam in paper order with the boss exam last
 * and marked: status, best and latest score, attempts, and where a tap goes (start, resume, or
 * its page with the history).
 */
import Link from "next/link";
import type { AttemptSummary, MockExamListing } from "@/lib/mock-exams/types";
import { num, shortDay } from "./format";

export function MockTrend({ attempts, max = 24, title = "Every attempt so far" }: { attempts: AttemptSummary[]; max?: number; title?: string }) {
  if (!attempts.length) return null;
  const W = 320;
  const H = 72;
  const pad = 6;
  const n = attempts.length;
  const x = (i: number) => (n === 1 ? W / 2 : pad + (i / (n - 1)) * (W - pad * 2));
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const d = attempts.map((a, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(a.score.total).toFixed(1)}`).join("");
  const last = attempts[n - 1];
  const label = attempts.map((a) => `${a.examTitle} ${shortDay(a.finishedAt)}: ${num(a.score.total)}`).join("; ");
  return (
    <div className="rounded-2xl border border-line bg-surface p-4" data-testid="mock-trend">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[15px] text-ink">{title}</span>
        <span className="font-mono text-[13px] text-ink-2">
          latest {num(last.score.total)} / {max}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 block h-auto w-full max-w-[520px]" role="img" aria-label={`Scores out of ${max}, oldest first. ${label}`}>
        {[0, 12, 24].map((v) => (
          <line key={v} x1={0} x2={W} y1={y(v)} y2={y(v)} style={{ stroke: "var(--line)", strokeWidth: 1 }} />
        ))}
        {n > 1 ? <path d={d} style={{ fill: "none", stroke: "var(--ink-2)", strokeWidth: 1.6, strokeLinejoin: "round" }} /> : null}
        {attempts.map((a, i) => (
          <circle key={a.id} cx={x(i)} cy={y(a.score.total)} r={i === n - 1 ? 4 : 3} style={{ fill: i === n - 1 ? "var(--accent)" : "var(--ink)" }} />
        ))}
      </svg>
      <p className="mt-1 font-mono text-[12px] text-ink-3">
        {n} {n === 1 ? "attempt" : "attempts"} · out of {max} · oldest first
      </p>
    </div>
  );
}

function Chip({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "boss" | "teacher" | "open" | "done" }) {
  const cls = {
    plain: "bg-paper text-ink-2",
    boss: "bg-due/15 text-due",
    teacher: "bg-butter/60 text-ink",
    open: "bg-sky/50 text-ink",
    done: "bg-mint/60 text-ink",
  }[tone];
  return <span className={`rounded-full px-2.5 py-0.5 text-[12px] ${cls}`}>{children}</span>;
}

export function MockExamCard({ exam }: { exam: MockExamListing }) {
  const boss = exam.kind === "boss";
  const href = exam.openAttemptId ? `/exams/mock/attempt/${exam.openAttemptId}` : `/exams/mock/${exam.id}`;
  const go = exam.status === "open" ? "Resume" : exam.status === "done" ? "Open" : "Start";
  return (
    <Link
      href={href}
      className={`block rounded-2xl border bg-surface p-4 transition-colors duration-quick hover:border-ink-3 ${boss ? "border-due/40" : "border-line"}`}
      data-testid="mock-card"
    >
      <span className="flex flex-wrap gap-1.5">
        {boss ? <Chip tone="boss">Boss</Chip> : null}
        {exam.kind === "teacher" ? <Chip tone="teacher">From your teacher</Chip> : null}
        {exam.status === "new" ? <Chip>Not started</Chip> : exam.status === "open" ? <Chip tone="open">In progress</Chip> : <Chip tone="done">Done</Chip>}
      </span>
      <span className="mt-2 block font-display text-[20px] leading-tight text-ink">{exam.title}</span>
      <span className="mt-0.5 block text-[14px] text-ink-2">{exam.subtitle}</span>
      {boss && exam.expectedScore ? (
        <span className="mt-2 block text-[14px] text-ink-2">
          A well-prepared student scores {exam.expectedScore.low} to {exam.expectedScore.high} of {exam.totalPoints} here.
        </span>
      ) : null}
      <span className="mt-3 flex items-end justify-between gap-3">
        {exam.attempts > 0 && exam.best != null && exam.latest != null ? (
          <span className="font-mono text-[13px] text-ink-2" data-testid="mock-card-scores">
            best <b className="font-medium text-ink">{num(exam.best)}</b> · latest {num(exam.latest)} / {exam.totalPoints} ·{" "}
            {exam.attempts} {exam.attempts === 1 ? "attempt" : "attempts"}
          </span>
        ) : (
          <span className="font-mono text-[13px] text-ink-3">4 questions · about {exam.suggestedMinutes} min</span>
        )}
        <span className="inline-flex min-h-11 items-center gap-1 text-[15px] font-semibold text-ink">
          {go}
          <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-none stroke-current [stroke-width:1.5]">
            <path d="M9.5 5.5L16 12l-6.5 6.5" />
          </svg>
        </span>
      </span>
    </Link>
  );
}

export function MockList({ exams, attempts, courseLine }: { exams: MockExamListing[]; attempts: AttemptSummary[]; courseLine?: string }) {
  return (
    <div className="mt-5 grid gap-3.5">
      {courseLine ? <p className="text-[15px] text-ink-2">{courseLine}</p> : null}
      <MockTrend attempts={attempts} />
      <ul className="grid list-none gap-3.5 min-[700px]:grid-cols-2">
        {exams.map((e) => (
          <li key={e.id} className={e.kind === "boss" ? "min-[700px]:col-span-2" : undefined}>
            <MockExamCard exam={e} />
          </li>
        ))}
      </ul>
    </div>
  );
}

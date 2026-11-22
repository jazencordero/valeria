/*
 * Mock exams (M3-60): the "Mock exams" tab of Exams.
 *
 * - On top, a small trend of every finished attempt, oldest first. Totals differ by kind (a full
 *   exam is out of 24, a figure set out of 18), so when they differ the trend is in percent of
 *   each attempt's own total; the marker says the group (dot: full exam, triangle: math, star:
 *   figures). With one total (one exam's history) it is in points out of that total.
 * - Then three groups in this order, each with one line saying what it is and how many are
 *   done: "Full exams" (the teacher's first, the boss last), "Math problems (question 3)",
 *   "Figures and tables (question 4)". Each exam is one compact row (title, then its scores or
 *   its length, then where a tap goes), so twenty rows stay calm on a phone; nothing is folded
 *   away. The boss row is marked and says what a well-prepared student scores.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import type { AttemptSummary, MockExamListing } from "@/lib/mock-exams/types";
import { num, shortDay } from "./format";

export type MockGroup = "full" | "math" | "figure";

export function groupOf(kind: string): MockGroup {
  if (kind === "drill-math") return "math";
  if (kind === "drill-figure") return "figure";
  return "full";
}

const GROUPS: { id: MockGroup; title: string; line: string }[] = [
  { id: "full", title: "Full exams", line: "The whole exam as on the day: true or false, then written questions." },
  { id: "math", title: "Math problems (question 3)", line: "Calculation problems like question 3, written and marked the same way." },
  { id: "figure", title: "Figures and tables (question 4)", line: "Read a figure or a table and explain it, like question 4." },
];

const kindRank = (kind: string) => (kind === "teacher" ? 0 : kind === "boss" ? 2 : 1);

function Mark({ group, x, y, last }: { group: MockGroup; x: number; y: number; last?: boolean }) {
  const color = last ? "var(--accent)" : "var(--ink)";
  if (group === "math") {
    const r = 4.6;
    return (
      <polygon
        points={`${x},${y - r} ${x + r * 0.9},${y + r * 0.6} ${x - r * 0.9},${y + r * 0.6}`}
        style={{ fill: "var(--surface)", stroke: color, strokeWidth: 1.6, strokeLinejoin: "round" }}
      />
    );
  }
  if (group === "figure") {
    const r = 4.4;
    let d = "";
    for (let a = 0; a < 3; a++) {
      const t = (a * Math.PI) / 3 + Math.PI / 2;
      d += `M${x - Math.cos(t) * r} ${y - Math.sin(t) * r}L${x + Math.cos(t) * r} ${y + Math.sin(t) * r}`;
    }
    return <path d={d} style={{ stroke: color, strokeWidth: 1.7, strokeLinecap: "round", fill: "none" }} />;
  }
  return <circle cx={x} cy={y} r={last ? 4 : 3.2} style={{ fill: color }} />;
}

export function MockTrend({
  attempts,
  kinds = {},
  title = "Every attempt so far",
}: {
  attempts: AttemptSummary[];
  /** Exam id → kind, to mark each attempt with its group. */
  kinds?: Record<string, string>;
  title?: string;
}) {
  if (!attempts.length) return null;
  const maxes = new Set(attempts.map((a) => a.score.max));
  const percent = maxes.size > 1;
  const top = percent ? 100 : attempts[0].score.max;
  const value = (a: AttemptSummary) => (percent ? (a.score.total / a.score.max) * 100 : a.score.total);
  const W = 320;
  const H = 72;
  const pad = 7;
  const n = attempts.length;
  const x = (i: number) => (n === 1 ? W / 2 : pad + (i / (n - 1)) * (W - pad * 2));
  const y = (v: number) => H - pad - (v / top) * (H - pad * 2);
  const d = attempts.map((a, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(value(a)).toFixed(1)}`).join("");
  const last = attempts[n - 1];
  const show = (a: AttemptSummary) => (percent ? `${Math.round(value(a))}%` : `${num(a.score.total)} / ${a.score.max}`);
  const groups = new Set(attempts.map((a) => groupOf(kinds[a.examId] ?? "")));
  const label = attempts.map((a) => `${a.examTitle} ${shortDay(a.finishedAt)}: ${show(a)}`).join("; ");
  return (
    <div className="rounded-2xl border border-line bg-surface p-4" data-testid="mock-trend">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[15px] text-ink">{title}</span>
        <span className="font-mono text-[13px] text-ink-2">latest {show(last)}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 block h-auto w-full max-w-[520px]"
        role="img"
        aria-label={`${percent ? "Percent of the points" : `Scores out of ${top}`}, oldest first. ${label}`}
      >
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={y(f * top)} y2={y(f * top)} style={{ stroke: "var(--line)", strokeWidth: 1 }} />
        ))}
        {n > 1 ? <path d={d} style={{ fill: "none", stroke: "var(--ink-3)", strokeWidth: 1.4, strokeLinejoin: "round" }} /> : null}
        {attempts.map((a, i) => (
          <Mark key={a.id} group={groupOf(kinds[a.examId] ?? "")} x={x(i)} y={y(value(a))} last={i === n - 1} />
        ))}
      </svg>
      <p className="mt-1 flex flex-wrap gap-x-3 font-mono text-[12px] text-ink-3">
        <span>
          {n} {n === 1 ? "attempt" : "attempts"} · {percent ? "percent of each set's points" : `out of ${top}`} · oldest first
        </span>
        {percent && groups.size > 1 ? (
          <span aria-hidden="true" className="inline-flex gap-2.5">
            {GROUPS.filter((g) => groups.has(g.id)).map((g) => (
              <span key={g.id} className="inline-flex items-center gap-1">
                <svg width="12" height="12" viewBox="0 0 12 12">
                  <Mark group={g.id} x={6} y={6.5} />
                </svg>
                {g.id === "full" ? "full" : g.id === "math" ? "math" : "figures"}
              </span>
            ))}
          </span>
        ) : null}
      </p>
    </div>
  );
}

function Chip({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "boss" | "teacher" | "open" | "done" }) {
  const cls = {
    plain: "bg-paper text-ink-2",
    boss: "bg-due/15 text-due",
    teacher: "bg-butter/60 text-ink",
    open: "bg-sky/50 text-ink",
    done: "bg-mint/60 text-ink",
  }[tone];
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] ${cls}`}>{children}</span>;
}

export function MockExamRow({ exam }: { exam: MockExamListing }) {
  const boss = exam.kind === "boss";
  const href = exam.openAttemptId ? `/exams/mock/attempt/${exam.openAttemptId}` : `/exams/mock/${exam.id}`;
  const go = exam.status === "open" ? "Resume" : exam.status === "done" ? "Open" : "Start";
  const scored = exam.attempts > 0 && exam.best != null && exam.latest != null;
  return (
    <Link
      href={href}
      className={`flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors duration-quick hover:bg-paper ${boss ? "bg-due/5" : ""}`}
      data-testid="mock-card"
    >
      <span className="min-w-0 grow">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-display text-[17px] leading-tight text-ink">{exam.title}</span>
          {boss ? <Chip tone="boss">Boss</Chip> : null}
          {exam.kind === "teacher" ? <Chip tone="teacher">From your teacher</Chip> : null}
          {exam.status === "open" ? <Chip tone="open">In progress</Chip> : null}
        </span>
        <span className="mt-0.5 block font-mono text-[12.5px] text-ink-2" data-testid="mock-card-scores">
          {scored ? (
            <>
              best <b className="font-medium text-ink">{num(exam.best!)}</b> · latest {num(exam.latest!)} / {exam.totalPoints} ·{" "}
              {exam.attempts} {exam.attempts === 1 ? "attempt" : "attempts"}
            </>
          ) : (
            <span className="text-ink-3">
              {exam.totalPoints} points · about {exam.suggestedMinutes} min
            </span>
          )}
        </span>
        {boss && exam.expectedScore ? (
          <span className="mt-0.5 block text-[13px] text-ink-2">
            Harder on purpose: a well-prepared student scores {exam.expectedScore.low} to {exam.expectedScore.high} of{" "}
            {exam.totalPoints}.
          </span>
        ) : null}
      </span>
      <span className="inline-flex flex-none items-center gap-1 text-[15px] font-semibold text-ink">
        {go}
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-none stroke-current [stroke-width:1.5]">
          <path d="M9.5 5.5L16 12l-6.5 6.5" />
        </svg>
      </span>
    </Link>
  );
}

/** Kept for callers that show one exam as a card (the old name). */
export const MockExamCard = MockExamRow;

export function MockList({ exams, attempts }: { exams: MockExamListing[]; attempts: AttemptSummary[] }) {
  const kinds = Object.fromEntries(exams.map((e) => [e.id, e.kind]));
  return (
    <div className="mt-5 grid gap-6">
      <MockTrend attempts={attempts} kinds={kinds} />
      {GROUPS.map((g) => {
        const rows = exams
          .filter((e) => groupOf(e.kind) === g.id)
          .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.order - b.order);
        if (!rows.length) return null;
        const done = rows.filter((e) => e.attempts > 0).length;
        return (
          <section key={g.id} aria-labelledby={`mock-${g.id}`} data-testid={`mock-group-${g.id}`}>
            <div className="flex items-baseline justify-between gap-3">
              <h2 id={`mock-${g.id}`} className="type-h22">
                {g.title}
              </h2>
              <span className="whitespace-nowrap font-mono text-[12.5px] text-ink-3">
                {done} of {rows.length} done
              </span>
            </div>
            <p className="mt-0.5 text-[14px] text-ink-2">{g.line}</p>
            <ul className="mt-2.5 list-none divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {rows.map((e) => (
                <li key={e.id}>
                  <MockExamRow exam={e} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

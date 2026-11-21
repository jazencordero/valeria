/*
 * Mock exams (M3-60): the result of a finished attempt. The total out of 24 (the server's score),
 * the boss line when it is the boss exam, each question's score with a small bar, then "Where
 * you lost points": every point not earned, grouped by the lecture to reread, biggest first,
 * each group linking to that lecture page. Then Review answers, Retake, Back to mock exams.
 * An attempt she changed after finishing says "edited".
 */
import type { Attempt, MockExam } from "@/lib/mock-exams/types";
import { Button } from "@/components/ui/button";
import { itemLetter, liveScore, minutesUsed, MINUS, num, partsOf, shortDay } from "./format";
import { LectureLink, type LinkedLecture } from "./lecture-link";
import { RetakeButton } from "./retake-button";

type Lost = { label: string; text: string; lost: number; tag: string };
type Group = { lecture: LinkedLecture; items: Lost[]; lost: number };

const r2 = (n: number) => Math.round(n * 100) / 100;

export function lostPoints(exam: MockExam, attempt: Attempt): Group[] {
  const groups = new Map<string, Group>();
  const add = (lec: LinkedLecture | undefined, item: Lost) => {
    if (!lec) return;
    let g = groups.get(lec.page);
    if (!g) {
      g = { lecture: { ...lec, slides: [] }, items: [], lost: 0 };
      groups.set(lec.page, g);
    }
    for (const s of lec.slides) if (!g.lecture.slides.includes(s)) g.lecture.slides.push(s);
    g.lecture.href ??= lec.href;
    g.items.push(item);
    g.lost = r2(g.lost + item.lost);
  };
  const order = attempt.tfOrder;
  for (const q of exam.questions) {
    if (q.type !== "truefalse") continue;
    q.items.forEach((it, i) => {
      const a = attempt.trueFalse[String(i)];
      if (a === it.answer) return;
      const blank = a === null || a === undefined;
      const shown = order.indexOf(i);
      add(it.lectures[0] as LinkedLecture, {
        label: `${q.number}${itemLetter(shown >= 0 ? shown : i)}`,
        text: `${it.text} (${it.answer ? "True" : "False"}${blank ? ", you left it blank" : ""})`,
        lost: blank ? 1 : 2,
        tag: blank ? "blank" : `${MINUS}1`,
      });
    });
  }
  for (const p of partsOf(exam.questions)) {
    const given = new Set((attempt.ticks[p.key] ?? []).map((t) => t.index));
    p.part.ticks.forEach((tk, i) => {
      if (!given.has(i)) add(p.part.lectures[0] as LinkedLecture, { label: p.label, text: tk.text, lost: tk.points, tag: `${num(tk.points)}p` });
    });
  }
  return [...groups.values()]
    .map((g) => ({ ...g, lecture: { ...g.lecture, slides: [...g.lecture.slides].sort((a, b) => a - b) } }))
    .sort((a, b) => b.lost - a.lost);
}

export function Result({ exam, attempt }: { exam: MockExam; attempt: Attempt }) {
  const live = liveScore(exam, attempt);
  const score = attempt.score ?? live;
  const groups = lostPoints(exam, attempt);
  const boss = exam.kind === "boss" && exam.expectedScore;
  return (
    <div className="mx-auto max-w-[720px] px-[var(--pad)] pt-[max(20px,env(safe-area-inset-top,0px))] pb-10">
      <Button variant="text" href={`/exams/mock/${exam.id}`} className="-ml-1">
        ← {exam.title}
      </Button>
      <p className="mt-3 font-mono text-[12px] uppercase tracking-wide text-ink-3">
        {attempt.finishedAt ? shortDay(attempt.finishedAt) : ""}
        {attempt.secondsUsed ? ` · ${minutesUsed(attempt.secondsUsed)}` : ""}
        {attempt.edited ? " · edited" : ""}
      </p>
      <h1 className="sr-only" tabIndex={-1}>
        Your result: {num(score.total)} of {score.max}
      </h1>
      <p className="font-display text-[56px] leading-none" aria-hidden="true" data-testid="result-total">
        {num(score.total)} <small className="text-[24px] text-ink-3">/ {score.max}</small>
      </p>
      {boss ? (
        <p className="mt-3 text-[15px] text-ink-2">
          {score.total >= boss.low
            ? "Right where a well-prepared student lands."
            : "Below the usual range, and that is fine. This one is harder on purpose."}{" "}
          A well-prepared student scores {boss.low} to {boss.high} here.
        </p>
      ) : null}

      <div className="mt-5 rounded-2xl border border-line bg-surface px-4">
        {score.questions.map((q) => {
          const type = exam.questions.find((x) => x.number === q.number)?.type;
          return (
            <div key={q.number} className="flex min-h-12 items-center gap-3 border-t border-line first:border-t-0" data-testid="result-q">
              <span className="grow">
                Question {q.number}
                <span className="ml-2 text-[13px] text-ink-3">{type === "truefalse" ? "True or false" : "Written"}</span>
              </span>
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-line" aria-hidden="true">
                <b className="block h-full bg-ink" style={{ width: `${Math.round((q.score / q.max) * 100)}%` }} />
              </span>
              <span className="w-16 text-right font-mono text-[14px]">
                {num(q.score)} / {num(q.max)}
              </span>
            </div>
          );
        })}
      </div>

      <h2 className="type-h22 mt-8">Where you lost points</h2>
      {groups.length ? (
        <>
          <p className="mt-1 text-[14px] text-ink-3">Grouped by lecture, biggest first.</p>
          <div className="mt-3 grid gap-3">
            {groups.map((g) => (
              <div key={g.lecture.page} className="rounded-2xl border border-line bg-surface p-4" data-testid="lost-group">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-display text-[18px]">{g.lecture.title}</h3>
                  <span className="whitespace-nowrap font-mono text-[13px] text-ink-2">
                    {num(g.lost)} {g.lost === 1 ? "point" : "points"}
                  </span>
                </div>
                <ul className="mt-2 grid gap-1.5 text-[14px]">
                  {g.items.map((it, i) => (
                    <li key={i} className="grid grid-cols-[minmax(3.2em,auto)_1fr_auto] gap-x-2.5">
                      <span className="whitespace-nowrap font-mono text-ink-3">{it.label}</span>
                      <span className="text-ink-2">{it.text}</span>
                      <span className="font-mono text-ink-3">{it.tag}</span>
                    </li>
                  ))}
                </ul>
                <LectureLink lecture={g.lecture} />
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-2 text-ink-2">Nowhere. Every point is ticked.</p>
      )}

      <div className="mt-8 grid gap-2.5 min-[480px]:grid-cols-3">
        <Button variant="secondary" href={`/exams/mock/attempt/${attempt.id}?view=mark&q=1`}>
          Review answers
        </Button>
        <RetakeButton examId={exam.id} />
        <Button href="/exams">Back to mock exams</Button>
      </div>
    </div>
  );
}

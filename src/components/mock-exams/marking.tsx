"use client";
/*
 * Mock exams (M3-60): marking a finished attempt, one question per screen.
 *
 * - Question 1 is marked for her: per item her choice, the answer, +1 / −1 / 0, why, the note
 *   on a less certain key (practice 1(f)), and the lecture to reread.
 * - Questions 2 to 4: per part her answer beside the model answer (labelled with the exam's
 *   `answersLabel`), the ticks she gives herself, the part's score, the usual wrong answer and
 *   the lectures. Each tick is saved on the server at once; the score shown is the server's as
 *   soon as it answers (an instant local sum until then).
 * - "Check my answer" only when the server says it is allowed (`checkAllowed`). It suggests
 *   ticks and says in two lines what was missing; suggested ticks are added only where she has
 *   not touched a tick herself, and are saved as from the check. "unavailable" shows nothing.
 * - A change after her first pass (she has seen the result once) is an edit: the attempt then
 *   says "edited".
 * - A past attempt opens read-only: the same screen with the ticks fixed and no check.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { setMockTicksAction, suggestMockTicksAction } from "@/app/(app)/exams/mock/actions";
import { Button } from "@/components/ui/button";
import type {
  Attempt,
  GivenTick,
  MockExam,
  TrueFalseQuestion,
  WrittenPart,
  WrittenQuestion,
} from "@/lib/mock-exams/types";
import { partKey } from "@/lib/mock-exams/types";
import { itemLetter, liveScore, MINUS, num, partScore, points, signed } from "./format";
import { LectureLink, type LinkedLecture } from "./lecture-link";
import { PaperHeader, SectionContext } from "./paper";

const seenKey = (attemptId: string) => `ready.mock.seen.${attemptId}`;

export function markedOnce(attemptId: string): boolean {
  try {
    return window.localStorage.getItem(seenKey(attemptId)) === "1";
  } catch {
    return false;
  }
}

export function rememberMarked(attemptId: string): void {
  try {
    window.localStorage.setItem(seenKey(attemptId), "1");
  } catch {
    // Without storage every later change still saves; it is just not called an edit.
  }
}

type Check =
  | { state: "loading" }
  | { state: "done"; suggested: number[]; missing: string[]; empty: boolean };

export function Marking({
  exam,
  attempt: initial,
  checkAllowed,
  initialQ,
  readOnly,
}: {
  exam: MockExam;
  attempt: Attempt;
  checkAllowed: boolean;
  initialQ: number;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ);
  const [attempt, setAttempt] = useState(initial);
  const [touched, setTouched] = useState<Record<string, number[]>>({});
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [failed, setFailed] = useState(false);
  // Once the server says the check is unavailable, the button goes for this visit: self-marking.
  const [checkOff, setCheckOff] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const seq = useRef(new Map<string, number>());

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("q", String(q));
    window.history.replaceState(window.history.state, "", url);
  }, [q]);

  const live = liveScore(exam, attempt);
  const total = live.total;
  const question = exam.questions[q - 1];
  const qScore = live.questions[q - 1];

  const save = async (key: string, ticks: GivenTick[]) => {
    const n = (seq.current.get(key) ?? 0) + 1;
    seq.current.set(key, n);
    setAttempt((a) => ({ ...a, ticks: { ...a.ticks, [key]: ticks } }));
    try {
      const next = await setMockTicksAction(attempt.id, key, ticks, markedOnce(attempt.id));
      if (seq.current.get(key) === n) {
        setAttempt((a) => ({ ...next, ticks: { ...next.ticks, [key]: a.ticks[key] ?? next.ticks[key] } }));
        setFailed(false);
      }
    } catch {
      setFailed(true);
    }
  };

  const toggle = (key: string, index: number, on: boolean) => {
    const cur = attempt.ticks[key] ?? [];
    const next = on
      ? [...cur.filter((t) => t.index !== index), { index, fromCheck: false }]
      : cur.filter((t) => t.index !== index);
    next.sort((a, b) => a.index - b.index);
    setTouched((t) => ({ ...t, [key]: [...new Set([...(t[key] ?? []), index])] }));
    void save(key, next);
  };

  const check = async (key: string) => {
    setChecks((c) => ({ ...c, [key]: { state: "loading" } }));
    const r = await suggestMockTicksAction(attempt.id, key);
    if (r.status !== "ok") {
      setCheckOff(true);
      setChecks((c) => {
        const { [key]: _drop, ...rest } = c;
        void _drop;
        return rest;
      });
      return;
    }
    const mine = new Set(touched[key] ?? []);
    const cur = attempt.ticks[key] ?? [];
    const have = new Set(cur.map((t) => t.index));
    const added = r.ticks.filter((i) => !mine.has(i) && !have.has(i)).map((index) => ({ index, fromCheck: true }));
    if (added.length) void save(key, [...cur, ...added].sort((a, b) => a.index - b.index));
    setChecks((c) => ({
      ...c,
      [key]: { state: "done", suggested: r.ticks, missing: r.missing.slice(0, 2), empty: !(attempt.texts[key] ?? "").trim() },
    }));
  };

  const goTo = (n: number) => {
    setQ(n);
    scrollRef.current?.scrollTo({ top: 0 });
    requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
  };

  const close = `/exams/mock/${exam.id}`;
  const result = `/exams/mock/attempt/${attempt.id}?view=result`;

  return (
    <div ref={scrollRef} className="fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-paper text-ink">
      <div className="sticky top-0 z-20 border-b border-line bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-[860px] items-center gap-2 px-[var(--pad)] py-1.5">
          <Button
            variant="icon"
            href={readOnly ? `/exams/mock/${exam.id}` : close}
            aria-label={readOnly ? "Close this past attempt" : "Leave marking, it is saved"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="fill-none stroke-current [stroke-linecap:round] [stroke-width:1.6]">
              <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
            </svg>
          </Button>
          <span className="font-mono text-[13px] text-ink-2">
            {readOnly ? "Past attempt" : "Marking"} · {q} of 4
          </span>
          <span className="grow" />
          {failed ? (
            <span className="font-mono text-[12px] text-due" role="status">
              Not saved
            </span>
          ) : null}
          <span className="rounded-full bg-surface px-3 py-1 font-mono text-[13px]" aria-live="polite" data-testid="mark-total">
            <b className="font-medium text-ink">{num(total)}</b> <span className="text-ink-3">/ {exam.totalPoints}</span>
          </span>
        </div>
        <div className="mx-auto flex max-w-[860px] gap-1 px-[var(--pad)] pb-1.5" aria-hidden="true">
          {[1, 2, 3, 4].map((i) => (
            <i key={i} className={`h-1 flex-1 rounded-full ${i <= q ? "bg-ink" : "bg-line"}`} />
          ))}
        </div>
      </div>

      <main className="mx-auto max-w-[860px] px-[var(--pad)] pt-4 pb-32">
        <PaperHeader header={exam.paperHeader} />
        <div className="mt-5 flex items-end justify-between gap-3">
          <div>
            <span className="font-mono text-[12px] uppercase tracking-wide text-ink-3">
              {question.type === "truefalse" ? "Marked for you" : readOnly ? "Your ticks" : "Tick what you wrote"}
            </span>
            <h1 ref={headingRef} tabIndex={-1} className="type-h26">
              Question {q}
            </h1>
          </div>
          <span className="font-display text-[26px]" data-testid="q-score">
            {num(qScore.score)} <small className="text-[15px] text-ink-3">/ {num(qScore.max)}</small>
          </span>
        </div>

        {question.type === "truefalse" ? (
          <TrueFalseMarks question={question} attempt={attempt} />
        ) : (
          <WrittenMarks
            exam={exam}
            question={question}
            attempt={attempt}
            readOnly={readOnly}
            checkAllowed={checkAllowed && !readOnly && !checkOff}
            checks={checks}
            touched={touched}
            onToggle={toggle}
            onCheck={check}
          />
        )}
      </main>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-paper/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur">
        <div className="mx-auto flex max-w-[860px] gap-2.5 px-[var(--pad)] py-2.5">
          {q > 1 ? (
            <Button variant="secondary" block onClick={() => goTo(q - 1)}>
              Back
            </Button>
          ) : null}
          {q < 4 ? (
            <Button block onClick={() => goTo(q + 1)}>
              Next
            </Button>
          ) : (
            <Button
              block
              onClick={() => {
                if (!readOnly) rememberMarked(attempt.id);
                router.push(result);
                router.refresh();
              }}
            >
              {readOnly ? "See the result" : "See my result"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function TrueFalseMarks({ question, attempt }: { question: TrueFalseQuestion; attempt: Attempt }) {
  const order = attempt.tfOrder.length ? attempt.tfOrder : question.items.map((_, i) => i);
  return (
    <>
      <p className="mt-3 text-[14px] text-ink-2">
        Right +1 · Wrong {MINUS}1 · Blank 0. Question 1 never goes below 0.
      </p>
      <div className="mt-3 grid gap-3">
        {order.map((item, k) => {
          const it = question.items[item];
          const a = attempt.trueFalse[String(item)];
          const d = a === null || a === undefined ? 0 : a === it.answer ? 1 : -1;
          const you = a === null || a === undefined ? "Left blank" : a ? "True" : "False";
          return (
            <div key={item} className="rounded-2xl border border-line bg-surface p-4" data-testid="tf-mark">
              <p className="grid grid-cols-[2.1em_1fr] gap-x-1 font-display text-[16px] leading-[1.5]">
                <span className="text-ink-2">{itemLetter(k)}</span>
                <span>{it.text}</span>
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[14px]">
                <span className="rounded-full bg-paper px-2.5 py-1">
                  You: <b className="font-medium">{you}</b>
                </span>
                <span className="rounded-full bg-paper px-2.5 py-1">
                  Answer: <b className="font-medium">{it.answer ? "True" : "False"}</b>
                </span>
                <span
                  className={`ml-auto font-mono text-[15px] ${d > 0 ? "text-ink" : d < 0 ? "text-due" : "text-ink-3"}`}
                >
                  {signed(d)}
                </span>
              </div>
              <p className="mt-2.5 text-[15px] text-ink-2">{it.why}</p>
              {it.note ? (
                <p className="mt-2 rounded-xl bg-butter/50 px-3 py-2 text-[14px] text-ink" data-testid="tf-note">
                  {it.note}
                </p>
              ) : null}
              <div className="mt-1">
                {(it.lectures as LinkedLecture[]).map((l) => (
                  <div key={`${l.page}${l.slides.join()}`}>
                    <LectureLink lecture={l} />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function WrittenMarks({
  exam,
  question,
  attempt,
  readOnly,
  checkAllowed,
  checks,
  touched,
  onToggle,
  onCheck,
}: {
  exam: MockExam;
  question: WrittenQuestion;
  attempt: Attempt;
  readOnly: boolean;
  checkAllowed: boolean;
  checks: Record<string, Check>;
  touched: Record<string, number[]>;
  onToggle: (key: string, index: number, on: boolean) => void;
  onCheck: (key: string) => void;
}) {
  return (
    <>
      {question.prompt ? <p className="mt-3 font-display text-[16px]">{question.prompt}</p> : null}
      {question.sections.map((sec, si) => {
        const ctx = sec.stem || sec.formula || sec.figure || sec.table;
        return (
          <section key={si} className="mt-4">
            {sec.label ? <h2 className="font-display text-[18px] text-ink-2">{sec.label}</h2> : null}
            {ctx ? (
              <details className="group mt-1 rounded-2xl border border-line bg-surface px-4 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[14px] text-ink-2">
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-none stroke-current [stroke-width:1.5] transition-transform group-open:rotate-90">
                    <path d="M9.5 5.5L16 12l-6.5 6.5" />
                  </svg>
                  See the question{sec.figure ? " and figure" : sec.table ? " and table" : ""}
                </summary>
                <div className="pb-3 font-display text-[16px] leading-[1.55]">
                  <SectionContext section={sec} />
                </div>
              </details>
            ) : null}
            {sec.parts.map((p, pi) => {
              const key = partKey(question.number, si, pi);
              const label = `${question.number}${sec.label ? `${sec.label} ${p.label}` : p.label}`;
              return (
                <PartMark
                  key={key}
                  partKey={key}
                  label={label}
                  part={p}
                  answersLabel={exam.answersLabel}
                  her={attempt.texts[key] ?? ""}
                  given={attempt.ticks[key] ?? []}
                  readOnly={readOnly}
                  checkAllowed={checkAllowed}
                  check={checks[key]}
                  touched={touched[key] ?? []}
                  onToggle={onToggle}
                  onCheck={onCheck}
                />
              );
            })}
          </section>
        );
      })}
    </>
  );
}

function PartMark({
  partKey: key,
  label,
  part,
  answersLabel,
  her,
  given,
  readOnly,
  checkAllowed,
  check,
  touched,
  onToggle,
  onCheck,
}: {
  partKey: string;
  label: string;
  part: WrittenPart;
  answersLabel: string;
  her: string;
  given: GivenTick[];
  readOnly: boolean;
  checkAllowed: boolean;
  check: Check | undefined;
  touched: number[];
  onToggle: (key: string, index: number, on: boolean) => void;
  onCheck: (key: string) => void;
}) {
  const on = new Map(given.map((g) => [g.index, g]));
  const score = partScore(part, given);
  return (
    <div className="mt-3 rounded-2xl border border-line bg-surface p-4" data-testid="part-mark">
      <p className="grid grid-cols-[auto_1fr_auto] gap-x-2 font-display text-[16px] leading-[1.5]">
        <span className="text-ink-2">{label}</span>
        <span>{part.text}</span>
        <span className="whitespace-nowrap text-ink-2">({num(part.points)}p)</span>
      </p>
      <div className="mt-3 grid gap-3 min-[700px]:grid-cols-2">
        <div className="rounded-xl bg-paper p-3">
          <span className="font-mono text-[11px] uppercase tracking-wide text-ink-3">Your answer</span>
          <p className={`mt-1 whitespace-pre-wrap text-[15px] ${her.trim() ? "text-ink" : "italic text-ink-3"}`}>
            {her.trim() ? her : "Left empty"}
          </p>
        </div>
        <div className="rounded-xl bg-paper p-3">
          <span className="font-mono text-[11px] uppercase tracking-wide text-ink-3">{answersLabel}</span>
          <p className="mt-1 whitespace-pre-wrap text-[15px] text-ink">{part.modelAnswer}</p>
        </div>
      </div>
      <fieldset className="mt-3" disabled={readOnly}>
        <legend className="sr-only">What earns points in {label}</legend>
        {part.ticks.map((tk, i) => {
          const g = on.get(i);
          const suggested = check?.state === "done" && check.suggested.includes(i) && !touched.includes(i);
          return (
            <label
              key={i}
              className="flex min-h-11 cursor-pointer items-start gap-3 border-t border-line py-2.5 first:border-t-0 has-[:disabled]:cursor-default"
            >
              <input
                type="checkbox"
                className="mt-0.5 size-5 flex-none accent-[var(--ink)]"
                checked={!!g}
                disabled={readOnly}
                onChange={(e) => onToggle(key, i, e.currentTarget.checked)}
              />
              <span className="grow text-[15px]">
                {tk.text}
                {suggested || g?.fromCheck ? (
                  <span className="ml-2 rounded-full bg-sky/60 px-2 py-0.5 text-[12px] text-ink-2">suggested</span>
                ) : null}
              </span>
              <span className="font-mono text-[13px] text-ink-2">{num(tk.points)}p</span>
            </label>
          );
        })}
      </fieldset>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[14px] text-ink-2" aria-live="polite" data-testid="part-score">
          <b className="font-medium text-ink">{num(score)}</b> / {num(part.points)} for {label}
        </span>
        {checkAllowed ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onCheck(key)}
            loading={check?.state === "loading"}
            loadingLabel="Checking"
          >
            Check my answer
          </Button>
        ) : null}
      </div>
      {check?.state === "done" ? (
        <div className="mt-2 rounded-xl bg-sky/30 px-3 py-2 text-[14px]" role="status">
          <ul className="grid gap-1">
            {check.empty ? (
              <li>You left this part empty, so there is nothing to tick.</li>
            ) : check.missing.length ? (
              check.missing.map((m) => <li key={m}>{m}</li>)
            ) : (
              <li>Every point seems to be there. Read the model answer to be sure.</li>
            )}
          </ul>
          <p className="mt-1 text-ink-3">Your own ticks always win.</p>
        </div>
      ) : null}
      <div className="mt-3 rounded-xl bg-paper p-3">
        <span className="font-mono text-[11px] uppercase tracking-wide text-ink-3">The usual wrong answer</span>
        <p className="mt-1 text-[15px] text-ink">{part.commonWrong.answer}</p>
        <p className="mt-1 text-[14px] text-ink-2">{part.commonWrong.why}</p>
      </div>
      <div className="mt-1">
        {(part.lectures as LinkedLecture[]).map((l) => (
          <div key={`${l.page}${l.slides.join()}`}>
            <LectureLink lecture={l} />
          </div>
        ))}
      </div>
      <span className="sr-only">{points(score)}</span>
    </div>
  );
}

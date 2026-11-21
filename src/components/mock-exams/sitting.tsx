"use client";
/*
 * Mock exams (M3-60): sitting an exam, one question per screen, on a page that reads like the
 * teacher's paper. Around it only a thin bar: leave, "2 of 4", Saved, the timer, progress.
 *
 * - Every answer is saved on the server as she types (one save per field, 450 ms after the last
 *   key; a choice saves at once). "Saving" / "Saved" says where it is; a failed save says
 *   "Not saved, retrying" and tries again. Leaving the page flushes what is pending.
 * - Question 1 shows the items in this attempt's order, lettered (a) to (f) as on his paper,
 *   each with True / False / Leave blank. "Leave blank" is a real choice (null), the same as not
 *   answering, and the rule is shown under his prompt: right +1, wrong −1, blank 0.
 * - The timer is optional (chosen on the start screen) and she can hide it. It counts down from
 *   the suggested minutes; at zero it says "Time is up" and nothing else happens. The seconds
 *   used ride along with every save.
 * - The question she is on is kept in the URL (?q=) and in this browser, so leaving and coming
 *   back resumes there.
 * - Finishing on question 4 asks first when written parts are empty, then marks.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveMockAnswerAction, finishMockAttemptAction } from "@/app/(app)/exams/mock/actions";
import { Button } from "@/components/ui/button";
import type { Attempt, MockExamPaper, PaperTrueFalseQuestion, PaperWrittenQuestion, TrueFalseAnswer } from "@/lib/mock-exams/types";
import { partKey } from "@/lib/mock-exams/types";
import { clock, itemLetter, MINUS, partsOf } from "./format";
import { PaperHeader, PaperQuestion, PaperSectionBlock, PartLine } from "./paper";
import { useLastQuestion, useTimerPrefs, writeLastQuestion, writeTimer } from "./timer-prefs";

type SaveState = "saved" | "saving" | "failed";

export function Sitting({
  exam,
  attempt,
  initialQ,
}: {
  exam: MockExamPaper;
  attempt: Attempt;
  /** From ?q=; when absent, the question she was last on in this browser, else 1. */
  initialQ: number | null;
}) {
  const router = useRouter();
  const remembered = useLastQuestion(attempt.id);
  const [chosen, setQ] = useState<number | null>(initialQ);
  const q = chosen ?? remembered ?? 1;
  const [tf, setTf] = useState<Record<string, TrueFalseAnswer>>(attempt.trueFalse);
  const [texts, setTexts] = useState<Record<string, string>>(attempt.texts);
  const [save, setSave] = useState<SaveState>("saved");
  const [leaving, setLeaving] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const timer = useTimerPrefs(exam.id);
  const [secondsShown, setSecondsShown] = useState(attempt.secondsUsed);
  const seconds = useRef(attempt.secondsUsed);
  const pending = useRef(new Map<string, () => Promise<boolean>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const runRef = useRef<(key: string) => Promise<boolean>>(async () => true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Remember a question she moved to (not the default, which would overwrite the remembered one
  // before it is read).
  useEffect(() => {
    if (chosen == null) return;
    writeLastQuestion(attempt.id, chosen);
    const url = new URL(window.location.href);
    url.searchParams.set("q", String(chosen));
    window.history.replaceState(window.history.state, "", url);
  }, [attempt.id, chosen]);

  // Seconds on the clock: counted while the page is open.
  useEffect(() => {
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      seconds.current += Math.min(5, (now - last) / 1000);
      last = now;
      setSecondsShown(seconds.current);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  /** Runs the pending save of one field; false when it failed (it then retries in 3 s). */
  const run = useCallback(async (key: string): Promise<boolean> => {
    const job = pending.current.get(key);
    if (!job) return true;
    pending.current.delete(key);
    setSave("saving");
    let ok = false;
    try {
      ok = await job();
    } catch {
      ok = false;
    }
    if (!ok) {
      // Keep the newest job if one arrived meanwhile; else retry this one.
      if (!pending.current.has(key)) pending.current.set(key, job);
      setSave("failed");
      timers.current.set(
        key,
        setTimeout(() => void runRef.current(key), 3000),
      );
      return false;
    }
    if (pending.current.size === 0) setSave("saved");
    return true;
  }, []);

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const queue = useCallback(
    (key: string, job: () => Promise<boolean>, delay: number) => {
      pending.current.set(key, job);
      setSave("saving");
      const t = timers.current.get(key);
      if (t) clearTimeout(t);
      timers.current.set(
        key,
        setTimeout(() => void run(key), delay),
      );
    },
    [run],
  );

  /** Saves everything pending now; true when all of it is saved. */
  const flush = useCallback(async () => {
    const keys = [...pending.current.keys()];
    for (const k of keys) {
      const t = timers.current.get(k);
      if (t) clearTimeout(t);
    }
    const oks = await Promise.all(keys.map((k) => run(k)));
    return oks.every(Boolean);
  }, [run]);

  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [flush]);

  const setAnswer = (item: number, answer: TrueFalseAnswer) => {
    setTf((s) => ({ ...s, [String(item)]: answer }));
    queue(
      `tf${item}`,
      () => saveMockAnswerAction(attempt.id, { kind: "trueFalse", item, answer }, Math.round(seconds.current)),
      0,
    );
  };

  const setText = (part: string, text: string) => {
    setTexts((s) => ({ ...s, [part]: text }));
    queue(
      `t${part}`,
      () => saveMockAnswerAction(attempt.id, { kind: "text", part, text }, Math.round(seconds.current)),
      450,
    );
  };

  const goTo = async (n: number) => {
    setConfirmFinish(false);
    setQ(n);
    scrollRef.current?.scrollTo({ top: 0 });
    requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
  };

  const parts = useMemo(() => partsOf(exam.questions), [exam.questions]);
  const empty = parts.filter((p) => !(texts[p.key] ?? "").trim()).length;

  const finish = async () => {
    if (empty > 0 && !confirmFinish) {
      setConfirmFinish(true);
      return;
    }
    setFinishing(true);
    try {
      if (!(await flush())) throw new Error("not saved");
      await finishMockAttemptAction(attempt.id, Math.round(seconds.current));
      router.replace(`/exams/mock/attempt/${attempt.id}?view=mark&q=1`);
      router.refresh();
    } catch {
      setFinishing(false);
      setSave("failed");
    }
  };

  const question = exam.questions[q - 1];
  const left = exam.suggestedMinutes * 60 - secondsShown;

  return (
    <div ref={scrollRef} className="fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-paper text-ink">
      <div className="sticky top-0 z-20 border-b border-line bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-[760px] items-center gap-2 px-[var(--pad)] py-1.5">
          <Button
            variant="icon"
            aria-label="Leave the exam"
            onClick={() => setLeaving((v) => !v)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="fill-none stroke-current [stroke-linecap:round] [stroke-width:1.6]">
              <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
            </svg>
          </Button>
          <span className="font-mono text-[13px] text-ink-2">{q} of 4</span>
          <span
            className={`font-mono text-[12px] ${save === "failed" ? "text-due" : "text-ink-3"}`}
            aria-live="polite"
            data-testid="save-state"
          >
            {save === "saved" ? "Saved" : save === "saving" ? "Saving" : "Not saved, retrying"}
          </span>
          <span className="grow" />
          {timer.on ? (
            <span className="flex items-center gap-1">
              {timer.hidden ? null : (
                <span className={`font-mono text-[13px] ${left <= 0 ? "text-due" : "text-ink-2"}`} data-testid="timer">
                  {left <= 0 ? "Time is up" : `${clock(left * 1000)} left`}
                </span>
              )}
              <Button
                variant="icon"
                aria-label={timer.hidden ? "Show timer" : "Hide timer"}
                onClick={() => {
                  writeTimer(exam.id, { ...timer, hidden: !timer.hidden });
                }}
              >
                {timer.hidden ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="fill-none stroke-current [stroke-linecap:round] [stroke-width:1.6]">
                    <path d="M4 4l16 16M9.9 6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.8M6.2 7.6A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4-.9" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="fill-none stroke-current [stroke-linecap:round] [stroke-width:1.6]">
                    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
                    <circle cx="12" cy="12" r="2.8" />
                  </svg>
                )}
              </Button>
            </span>
          ) : null}
        </div>
        <div className="mx-auto flex max-w-[760px] gap-1 px-[var(--pad)] pb-1.5" aria-hidden="true">
          {[1, 2, 3, 4].map((i) => (
            <i key={i} className={`h-1 flex-1 rounded-full ${i <= q ? "bg-ink" : "bg-line"}`} />
          ))}
        </div>
        {leaving ? (
          <div className="mx-auto max-w-[760px] px-[var(--pad)] pb-3" role="group" aria-label="Leave the exam?">
            <div className="rounded-2xl border border-line bg-surface p-3">
              <p className="text-[15px]">Your answers are saved. You can come back.</p>
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setLeaving(false)}>
                  Keep going
                </Button>
                <Button
                  size="sm"
                  onClick={async () => {
                    await flush();
                    router.push(`/exams/mock/${exam.id}`);
                  }}
                >
                  Leave
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <main className="mx-auto max-w-[760px] px-[var(--pad)] pt-4 pb-40">
        <PaperHeader header={exam.paperHeader} />
        <h1 ref={headingRef} tabIndex={-1} className="sr-only">
          {exam.title}, question {q} of 4
        </h1>
        <div className="mt-5">
          {question.type === "truefalse" ? (
            <TrueFalse question={question} order={attempt.tfOrder} answers={tf} onAnswer={setAnswer} />
          ) : (
            <Written question={question} texts={texts} onText={setText} />
          )}
        </div>
      </main>

      <div className="fixed inset-x-0 bottom-0 z-20 pb-[env(safe-area-inset-bottom,0px)] border-t border-line bg-paper/95 backdrop-blur">
        <div className="mx-auto max-w-[760px] px-[var(--pad)] py-2.5">
          {confirmFinish ? (
            <div className="mb-2.5 rounded-2xl border border-line bg-surface p-3" role="group" aria-label="Some parts are empty">
              <p className="text-[15px]">
                {empty === 1 ? "1 written part is empty." : `${empty} written parts are empty.`} Mark anyway?
              </p>
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setConfirmFinish(false)}>
                  Keep writing
                </Button>
                <Button size="sm" onClick={finish} loading={finishing} loadingLabel="Marking">
                  Mark anyway
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex gap-2.5">
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
              <Button block onClick={finish} loading={finishing && !confirmFinish} loadingLabel="Marking">
                Finish and mark
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TrueFalse({
  question,
  order,
  answers,
  onAnswer,
}: {
  question: PaperTrueFalseQuestion;
  order: number[];
  answers: Record<string, TrueFalseAnswer>;
  onAnswer: (item: number, a: TrueFalseAnswer) => void;
}) {
  const shown = order.length ? order : question.items.map((_, i) => i);
  return (
    <PaperQuestion number={question.number} prompt={question.prompt}>
      <p className="mt-2 font-sans text-[13px] text-ink-2" data-testid="tf-rule">
        Right +1 · Wrong {MINUS}1 · Blank 0. Question 1 never goes below 0.
      </p>
      <div className="mt-1">
        {shown.map((item, k) => {
          const it = question.items[item];
          const a = answers[String(item)];
          const value = a === true ? "true" : a === false ? "false" : a === null ? "blank" : "";
          return (
            <fieldset key={item} className="mt-4 min-w-0" data-testid="tf-item">
              <legend className="grid grid-cols-[2.1em_1fr] gap-x-1">
                <span className="text-ink-2">{itemLetter(k)}</span>
                <span>{it.text}</span>
              </legend>
              <div className="ml-[calc(2.1em+4px)] mt-2 grid grid-cols-3 gap-1.5 font-sans text-[14px]">
                {(
                  [
                    ["true", "True", true],
                    ["false", "False", false],
                    ["blank", "Leave blank", null],
                  ] as const
                ).map(([v, label, ans]) => (
                  <label
                    key={v}
                    className="relative flex min-h-11 cursor-pointer items-center justify-center rounded-xl border border-line bg-surface px-2 text-center text-ink-2 transition-colors duration-quick has-[:checked]:border-ink has-[:checked]:bg-ink has-[:checked]:text-paper has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
                  >
                    <input
                      type="radio"
                      className="sr-only"
                      name={`tf-${item}`}
                      value={v}
                      checked={value === v}
                      onChange={() => onAnswer(item, ans)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
    </PaperQuestion>
  );
}

function grow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.max(112, el.scrollHeight + 2)}px`;
}

function Written({
  question,
  texts,
  onText,
}: {
  question: PaperWrittenQuestion;
  texts: Record<string, string>;
  onText: (part: string, text: string) => void;
}) {
  return (
    <PaperQuestion number={question.number} prompt={question.prompt}>
      {question.sections.map((sec, si) => (
        <PaperSectionBlock key={si} section={sec}>
          {sec.parts.map((p, pi) => {
            const key = partKey(question.number, si, pi);
            const label = `${question.number}${sec.label ? `${sec.label} ${p.label}` : p.label}`;
            return (
              <PartLine key={key} label={p.label} text={p.text} points={p.points} id={`pt-${key}`}>
                <textarea
                  ref={grow}
                  className="mt-2 block w-full resize-none rounded-xl border border-line bg-surface px-3 py-2.5 font-sans text-[16px] leading-normal text-ink placeholder:text-ink-3 focus:border-ink-3 focus:outline-none"
                  rows={4}
                  value={texts[key] ?? ""}
                  aria-labelledby={`pt-${key}`}
                  placeholder={`Your answer to ${label}`}
                  spellCheck
                  onChange={(e) => {
                    grow(e.currentTarget);
                    onText(key, e.currentTarget.value);
                  }}
                />
              </PartLine>
            );
          })}
        </PaperSectionBlock>
      ))}
    </PaperQuestion>
  );
}

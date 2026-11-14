"use client";

/**
 * Hand in sheet. Source: prototype main-flow.html HTML 1698-1724, CSS 929-957,
 * JS 4693-4749 (submit, drawCheck).
 *
 * Review (file, to, due with how early), then her tap on "Submit to <LMS>".
 * The fill sweeps across the button while the real request runs, for at
 * least 900 ms so it never flashes. On success: the receipt (check that
 * draws, one ring pulse, the cap cheering) and the sheet is locked: it can
 * never submit again, but it can still be closed. On failure: one plain
 * sentence per reason, and a retry button only where retrying can help.
 *
 * The sheet itself ignores Escape and the scrim only while sending.
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Vitonen, type VitonenHandle } from "@/components/vitonen";
import { daysBetween, earlyBy, listDate, TIME_ZONE, type DateInput } from "@/lib/dates";
import { calmDuration, duration, ease } from "@/lib/motion/tokens";
import { useMotionMode, type MotionMode } from "@/lib/motion/use-calm";

/** Why a hand-in failed. Matches the reasons `confirmHandin` returns (M1-32). */
export type HandinFailReason = "expired" | "changed" | "refused" | "moodle_down" | "not_shown";

/**
 * What `onSubmit` resolves to. M1-32's `confirmHandin` should return this.
 * `submittedAt` is when the LMS recorded it; `message` is the LMS's own words
 * when it refused.
 */
export type Result =
  | { ok: true; submittedAt: DateInput }
  | { ok: false; reason: HandinFailReason; message?: string };

/** The review shown before her tap. Mirrors `prepareHandin`'s return (M1-32). */
export type HandinReview = {
  fileName: string;
  /** File size in bytes. */
  bytes: number;
  /** Page count, when known. */
  pages?: number;
  /** Where it goes, e.g. "Forecasting Methods › Assignment 3". */
  to: string;
  due: DateInput;
  /** "5 h 8 min early". Worked out from `now` when left out. */
  earlyBy?: string;
  /** Show the own-work line. Defaults to true. */
  needsStatement?: boolean;
};

export type HandinSheetProps = {
  open: boolean;
  onClose: () => void;
  review: HandinReview;
  onSubmit: () => Promise<Result>;
  /** The school's LMS name, e.g. "MyCourses". */
  lmsName: string;
  /** Where "Back to home" goes. Defaults to "/". */
  backHref?: string;
  /** Called instead of following `backHref`. */
  onBackHome?: () => void;
  /** Called once when the hand-in succeeds. */
  onHandedIn?: (result: Extract<Result, { ok: true }>) => void;
  /** The current time, for the due line. Defaults to the time of the first render. */
  now?: DateInput;
};

/** The shortest the fill sweep may take, so it never flashes. */
export const MIN_SEND_MS = 900;

/** Reasons where tapping again can help. */
const RETRYABLE: ReadonlySet<FailReason> = new Set<FailReason>(["moodle_down", "network"]);

/** `network`: onSubmit threw, so we never heard back. Not one of M1-32's reasons. */
type FailReason = HandinFailReason | "network";

type Phase =
  | { kind: "review" }
  | { kind: "sending" }
  | { kind: "failed"; reason: FailReason; message?: string }
  | { kind: "done"; submittedAt: DateInput };

/** The plain sentence for each failure. */
export function failSentence(reason: FailReason, lmsName: string, message?: string): string {
  switch (reason) {
    case "expired":
      return "This check is more than 10 minutes old, so nothing was sent. Close it and pick the file again.";
    case "changed":
      return "The file changed after you checked it, so nothing was sent. Pick it again to hand in this version.";
    case "refused":
      return message
        ? `${lmsName} did not take it. It said: “${message}”`
        : `${lmsName} did not take it. Open ${lmsName} to see why.`;
    case "moodle_down":
      return `${lmsName} is not answering right now, so nothing was sent. Try again in a minute.`;
    case "not_shown":
      return `It was sent, but ${lmsName} does not list it yet. Open ${lmsName} and check it is there before the deadline.`;
    case "network":
      return `The connection dropped before ${lmsName} answered. Try again; it will not hand in twice.`;
  }
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const clockFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function clock(at: DateInput): string {
  return clockFormat.format(at instanceof Date ? at : new Date(at));
}

/** "Today 21:00", "Tomorrow 09:00", else the list style "TUE 17 · 23:59". */
function dueParts(due: DateInput, now: DateInput): { day: string; time: string } | null {
  const days = daysBetween(now, due);
  if (days === 0) return { day: "Today", time: clock(due) };
  if (days === 1) return { day: "Tomorrow", time: clock(due) };
  return null;
}

/** "It is in MyCourses, 5 h 8 min before the deadline." */
function receiptSentence(lmsName: string, submittedAt: DateInput, due: DateInput): string {
  const early = earlyBy(submittedAt, due);
  if (early.endsWith(" early")) {
    return `It is in ${lmsName}, ${early.slice(0, -" early".length)} before the deadline.`;
  }
  if (early.startsWith("late by ")) {
    return `It is in ${lmsName}, ${early.slice("late by ".length)} after the deadline.`;
  }
  return `It is in ${lmsName}, right on the deadline.`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function swap(mode: MotionMode) {
  const d = mode === "instant" ? 0 : mode === "calm" ? calmDuration : duration.base;
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: d, ease: ease.out } },
    exit: { opacity: 0, transition: { duration: d, ease: "linear" as const } },
  };
}

function KvRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[64px_1fr] gap-x-3 border-t border-line py-3">
      <dt className="mono pt-[3px] uppercase ink-3">{label}</dt>
      <dd className="grid gap-[2px] text-[15px] min-w-0">{children}</dd>
    </div>
  );
}

function SubmitFill({ phase, mode }: { phase: Phase["kind"]; mode: MotionMode }) {
  // Sweeps to 85% over the 900 ms minimum, then creeps towards 96% while the
  // request is still out, and fills the rest when it lands.
  let animate: { scaleX: number | number[] };
  let transition: object;
  if (phase === "sending") {
    if (mode === "full") {
      animate = { scaleX: [0, 0.85, 0.96] };
      transition = { duration: 8, times: [0, MIN_SEND_MS / 8000, 1], ease: ["linear", "easeOut"] };
    } else {
      animate = { scaleX: 1 };
      transition = { duration: 0 };
    }
  } else if (phase === "done") {
    animate = { scaleX: 1 };
    transition = { duration: mode === "full" ? 0.15 : 0, ease: "linear" };
  } else {
    animate = { scaleX: 0 };
    transition = { duration: 0 };
  }
  return (
    <motion.span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 origin-left rounded-full bg-[var(--btn-ink)] opacity-20"
      initial={false}
      animate={animate}
      transition={transition}
    />
  );
}

function Check({ mode, cap }: { mode: MotionMode; cap: React.RefObject<VitonenHandle | null> }) {
  useEffect(() => {
    if (mode !== "full") return;
    const t = setTimeout(() => cap.current?.react("cheer"), 420);
    return () => clearTimeout(t);
  }, [mode, cap]);

  const full = mode === "full";
  return (
    <div className="relative mx-auto mt-2 mb-5 size-16" aria-hidden="true" data-testid="receipt-check">
      {full ? (
        <motion.span
          className="absolute inset-0 rounded-full border-2 border-solid border-accent"
          initial={{ opacity: 0, scale: 1 }}
          animate={{ opacity: [0.55, 0], scale: [1, 1.7] }}
          transition={{ duration: 0.6, delay: 0.22, ease: ease.out }}
        />
      ) : null}
      <span className="absolute -top-[30px] -right-[40px]">
        <Vitonen ref={cap} size={44} />
      </span>
      <motion.span
        className="absolute inset-0 grid place-items-center rounded-full bg-accent text-[var(--accent-ink)]"
        initial={full ? { opacity: 0, scale: 0.6 } : { opacity: mode === "calm" ? 0 : 1 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={
          full
            ? { type: "spring", bounce: 0.3, duration: 0.4 }
            : { duration: mode === "calm" ? calmDuration : 0 }
        }
      >
        <svg
          viewBox="0 0 24 24"
          className="size-8 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.8]"
        >
          <motion.path
            d="M6.5 12.5l3.5 3.5 7.5-8"
            initial={{ pathLength: full ? 0 : 1 }}
            animate={{ pathLength: 1 }}
            transition={full ? { duration: 0.42, delay: 0.16, ease: ease.out } : { duration: 0 }}
          />
        </svg>
      </motion.span>
    </div>
  );
}

export function HandinSheet({
  open,
  onClose,
  review,
  onSubmit,
  lmsName,
  backHref = "/",
  onBackHome,
  onHandedIn,
  now,
}: HandinSheetProps) {
  const mode = useMotionMode();
  const [phase, setPhase] = useState<Phase>({ kind: "review" });
  const [firstNow] = useState<DateInput>(() => now ?? Date.now());
  const busy = useRef(false);
  const handedIn = useRef(false);
  const backRef = useRef<HTMLDivElement | null>(null);
  const cap = useRef<VitonenHandle | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const at = now ?? firstNow;
  const locked = phase.kind === "done";
  const sending = phase.kind === "sending";

  const submit = async () => {
    // A ref, not state: a double tap lands twice before React re-renders.
    if (busy.current || handedIn.current) return;
    busy.current = true;
    setPhase({ kind: "sending" });
    const minimum = wait(mode === "instant" ? 0 : MIN_SEND_MS);
    let result: Result | null = null;
    try {
      result = await onSubmit();
    } catch {
      result = null;
    }
    await minimum;
    busy.current = false;
    if (!alive.current) return;
    if (result?.ok) {
      handedIn.current = true;
      setPhase({ kind: "done", submittedAt: result.submittedAt });
      onHandedIn?.(result);
    } else if (result) {
      setPhase({ kind: "failed", reason: result.reason, message: result.message });
    } else {
      setPhase({ kind: "failed", reason: "network" });
    }
  };

  // Focus "Back to home" once the receipt is in.
  useEffect(() => {
    if (phase.kind !== "done" || !open) return;
    const t = setTimeout(
      () => backRef.current?.querySelector<HTMLElement>("a,button")?.focus({ preventScroll: true }),
      mode === "full" ? duration.base * 2000 : 0,
    );
    return () => clearTimeout(t);
  }, [phase.kind, open, mode]);

  const failed = phase.kind === "failed" ? phase : null;
  const canRetry = failed ? RETRYABLE.has(failed.reason) : false;
  const showSubmit = !failed || canRetry;
  const dueAt = dueParts(review.due, at);
  const early = review.earlyBy ?? earlyBy(at, review.due);
  const label = sending ? `Sending to ${lmsName}` : canRetry ? "Try again" : `Submit to ${lmsName}`;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      locked={sending}
      aria-label={locked ? "Handed in" : `Hand in to ${lmsName}`}
      data-testid="handin-sheet"
    >
      <div data-locked={locked ? "true" : undefined} data-phase={phase.kind}>
        <AnimatePresence mode="wait" initial={false}>
          {phase.kind !== "done" ? (
            <motion.div key="review" {...swap(mode)}>
              <h2 className="type-h22">Hand in to {lmsName}</h2>
              <dl className="mt-5 mb-6 border-b border-line">
                <KvRow label="File">
                  <span className="mono-in truncate" title={review.fileName}>
                    {review.fileName}
                  </span>
                  <span className="text-[13px] ink-3">
                    {review.pages ? `${review.pages} ${review.pages === 1 ? "page" : "pages"} · ` : ""}
                    {sizeLabel(review.bytes)}
                  </span>
                </KvRow>
                <KvRow label="To">
                  <span>{review.to}</span>
                </KvRow>
                <KvRow label="Due">
                  <span>
                    {dueAt ? (
                      <>
                        {dueAt.day} <span className="mono-in">{dueAt.time}</span>
                      </>
                    ) : (
                      <span className="mono-in">{listDate(review.due)}</span>
                    )}
                  </span>
                  <span className="text-[13px] font-semibold ink-2">{early}</span>
                </KvRow>
              </dl>

              {failed ? (
                <p
                  role="alert"
                  data-testid="handin-error"
                  data-reason={failed.reason}
                  className="mb-4 rounded-2xl bg-accent-wash px-4 py-3 text-[15px] text-ink"
                >
                  {failSentence(failed.reason, lmsName, failed.message)}
                </p>
              ) : null}

              {showSubmit ? (
                <Button
                  block
                  size="lg"
                  className="overflow-hidden"
                  onClick={() => void submit()}
                  data-testid="handin-submit"
                >
                  <SubmitFill phase={phase.kind} mode={mode} />
                  <span className="relative">{label}</span>
                </Button>
              ) : null}
              <p className="sr-only" aria-live="polite">
                {sending ? `Sending to ${lmsName}` : ""}
              </p>
              {review.needsStatement !== false && showSubmit ? (
                <p className="fine mt-3 text-center">
                  Submitting confirms this is your own work, as {lmsName} asks.
                </p>
              ) : null}
              <Button
                variant="text"
                block
                className="mt-1"
                disabled={sending}
                onClick={onClose}
              >
                {failed && !canRetry ? "Close" : "Not yet"}
              </Button>
            </motion.div>
          ) : (
            <motion.div key="receipt" {...swap(mode)} className="pt-2 text-center">
              <Check mode={mode} cap={cap} />
              <h2 className="type-h22">Handed in</h2>
              <p className="mono mt-[6px] ink-3">
                {clock(phase.submittedAt)} · Submitted for grading
              </p>
              <p className="mx-auto mt-3 mb-6 max-w-[30ch] text-[15px] ink-2">
                {receiptSentence(lmsName, phase.submittedAt, review.due)}
              </p>
              <div ref={backRef}>
                {onBackHome ? (
                  <Button block size="lg" onClick={onBackHome}>
                    Back to home
                  </Button>
                ) : (
                  <Button block size="lg" href={backHref}>
                    Back to home
                  </Button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Sheet>
  );
}

"use client";

/**
 * The study session frame: a full-screen paper view around one card.
 * Source: prototype main-flow.html HTML 1674-1696 (#v-session), CSS 667-769
 * (.ss-*), JS 3121-3129 (tickTimer) and 3160-3180 (showToast, showCombo).
 *
 *   const frame = useRef<SessionFrameHandle>(null);
 *   <SessionFrame ref={frame} cards={cards} index={2} counts={counts}
 *     startedAt={start} streak={n} actions={<Grades />} hint="…" onStop={stop}>
 *     <Card />
 *   </SessionFrame>
 *   frame.current?.miss();                    // "Back in the pile…" 1.6 s
 *   frame.current?.climb("Supply", 3);        // "Supply climbed to Recall" 2.2 s
 *   frame.current?.react("nod");              // the cap
 *
 * Top: close, one progress segment per card (coloured by section, filled for
 * cards before `index`), "N new · N learning · N due" and an m:ss timer.
 * Close or Escape opens the stop confirm; Escape again closes it. The cap
 * peeks in on mount. The "N in a row" pill shows from 2 with a flame, turns
 * hot from 5, and every multiple of 5 fires 14 confetti pieces and a cheer.
 * Everything behind the frame is inert. Presentational: the caller owns the
 * session state and passes it in. No sound, no haptics.
 */
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { Pips, RUNG_NAMES } from "@/components/study/pips";
import { Button } from "@/components/ui/button";
import { burst } from "@/components/ui/confetti";
import { Vitonen, type VitonenHandle, type VitonenReaction } from "@/components/vitonen";
import { useInertOthers } from "@/lib/a11y/inert";
import { calmDuration, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { SectionKind } from "@/lib/study/bite";

export const MISS_TEXT = "Back in the pile. That is how it sticks.";
export const STOP_TEXT = "Stop here? Your progress is saved.";
export const TOAST_MISS_MS = 1600;
export const TOAST_CLIMB_MS = 2200;
export const TOAST_OUT_MS = 160;
export const PILL_FROM = 2;
export const PILL_HOT_FROM = 5;
export const CONFETTI_EVERY = 5;
export const CONFETTI_PIECES = 14;

/** Card head labels, per section. */
export const SECTION_LABEL: Record<SectionKind, string> = {
  warm: "WARM-UP",
  learn: "NEW",
  boss: "BOSS QUESTION",
};

/** Fill colour of a passed progress segment, per section. */
const SECTION_FILL: Record<SectionKind, string> = {
  warm: "bg-ink-3",
  learn: "bg-ink",
  boss: "bg-accent",
};

/** Whole seconds as m:ss ("0:00", "4:07", "12:30"). */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export type SessionCounts = { new: number; learning: number; due: number };

export function countsText(c: SessionCounts): string {
  return `${c.new} new · ${c.learning} learning · ${c.due} due`;
}

export type SessionFrameHandle = {
  /** Miss toast: "Back in the pile. That is how it sticks." for 1.6 s. */
  miss: () => void;
  /** Climb toast: "<concept> climbed to <rung>" with pips, for 2.2 s. */
  climb: (concept: string, rung: number) => void;
  /** Plays one cap reaction (nothing when calm). */
  react: (reaction: VitonenReaction) => void;
};

export type SessionFrameProps = {
  /** One entry per card in the run, in order; a requeued miss adds one. */
  cards: readonly { section: SectionKind }[];
  /** Cards before this index count as passed and fill their segment. */
  index: number;
  counts: SessionCounts;
  /** Epoch ms the session started (Date.now()). Omit to count from mount. */
  startedAt?: number;
  /** Current in-a-row count; the pill shows from 2. */
  streak?: number;
  /** Footer actions (grade buttons, Continue). */
  actions?: ReactNode;
  /** Footer hint line, e.g. "Space to reveal · 1–4 to grade". Hidden under 700 px. */
  hint?: ReactNode;
  /** Called when she taps Stop in the confirm. */
  onStop: () => void;
  /** The stage: the current card. */
  children?: ReactNode;
  ref?: Ref<SessionFrameHandle>;
};

type ToastInput = { kind: "miss" } | { kind: "climb"; concept: string; rung: number };
type Toast = ToastInput & { id: number; leaving: boolean };

const CloseIcon = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="fill-none stroke-current [stroke-linecap:round] [stroke-width:1.75]"
  >
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </svg>
);

const Flame = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="size-4 flex-none fill-none stroke-current [stroke-linejoin:round] [stroke-width:1.75]"
  >
    <path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2.2 1-3.6 2.2-4.6.2 1.6 1 2.6 2.3 3.1C11 9 10.6 6 12 3z" />
  </svg>
);

/** Ticks once a second; seconds since `startedAt` (or since mount). */
function useElapsed(startedAt: number | undefined): number {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t0 = startedAt ?? Date.now();
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      setSecs(Math.max(0, Math.floor((Date.now() - t0) / 1000)));
      t = setTimeout(tick, 1000);
    };
    t = setTimeout(tick, 0);
    return () => clearTimeout(t);
  }, [startedAt]);
  return secs;
}

export function SessionFrame({
  cards,
  index,
  counts,
  startedAt,
  streak = 0,
  actions,
  hint,
  onStop,
  children,
  ref,
}: SessionFrameProps) {
  const mode = useMotionMode();
  const rootRef = useInertOthers<HTMLElement>(true);
  const capRef = useRef<VitonenHandle>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const pillRef = useRef<HTMLParagraphElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const nextToast = useRef(1);
  const secs = useElapsed(startedAt);

  // The cap peeks in at the start.
  useEffect(() => {
    capRef.current?.react("peek");
  }, []);

  useEffect(() => {
    const timers = toastTimers;
    return () => clearAll(timers.current);
  }, []);

  const show = useCallback((next: ToastInput, stayMs: number) => {
    clearAll(toastTimers.current);
    const id = nextToast.current++;
    setToast({ ...next, id, leaving: false });
    toastTimers.current.push(
      setTimeout(() => {
        setToast((t) => (t && t.id === id ? { ...t, leaving: true } : t));
        toastTimers.current.push(
          setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), TOAST_OUT_MS),
        );
      }, stayMs),
    );
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      miss: () => show({ kind: "miss" }, TOAST_MISS_MS),
      climb: (concept, rung) => show({ kind: "climb", concept, rung }, TOAST_CLIMB_MS),
      react: (reaction) => capRef.current?.react(reaction),
    }),
    [show],
  );

  // A bump when the count grows while the pill is up; confetti and a cheer
  // on every new multiple of 5.
  const lastStreak = useRef(streak);
  useEffect(() => {
    const prev = lastStreak.current;
    lastStreak.current = streak;
    if (streak === prev || streak <= 0) return;
    const pill = pillRef.current;
    if (mode === "full" && prev >= PILL_FROM && pill && typeof pill.animate === "function") {
      pill.animate(
        [
          { transform: "translateX(-50%) scale(1)" },
          { transform: "translateX(-50%) scale(1.18)", offset: 0.4 },
          { transform: "translateX(-50%) scale(1)" },
        ],
        { duration: 320, easing: "cubic-bezier(.3,1.4,.5,1)" },
      );
    }
    if (streak % CONFETTI_EVERY !== 0) return;
    burst(pill, CONFETTI_PIECES);
    capRef.current?.react("cheer");
  }, [streak, mode]);

  // Close or Escape opens the confirm; Escape again closes it.
  const openConfirm = useCallback(() => setConfirming(true), []);
  const closeConfirm = useCallback(() => {
    setConfirming(false);
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      if (confirming) closeConfirm();
      else openConfirm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirming, closeConfirm, openConfirm]);
  useEffect(() => {
    if (confirming) keepRef.current?.focus({ preventScroll: true });
  }, [confirming]);

  const instant = mode === "instant";
  const full = mode === "full";
  const quick = instant ? 0 : calmDuration;

  const toastMotion = full
    ? {
        initial: { opacity: 0, y: 6, scale: 0.92 },
        transition: { type: "spring" as const, bounce: 0.3, duration: 0.28 },
      }
    : { initial: { opacity: 0 }, transition: { duration: quick } };

  const hot = streak >= PILL_HOT_FROM;
  const total = cards.length;
  const passed = Math.min(Math.max(0, index), total);

  return (
    <section
      ref={rootRef}
      aria-label="Study session"
      className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-paper text-ink"
    >
      <div
        className={
          "grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-2 " +
          "[grid-template-areas:'close_counts_time'_'prog_prog_prog'] " +
          "min-[700px]:grid-cols-[44px_minmax(0,1fr)_auto_auto] " +
          "min-[700px]:[grid-template-areas:'close_prog_counts_time'] " +
          "pt-[max(10px,env(safe-area-inset-top,0px))] pr-[var(--pad)] pb-2 " +
          "pl-[max(6px,calc(var(--pad)-14px))]"
        }
      >
        <Button
          ref={closeRef}
          variant="icon"
          aria-label="Stop session"
          className="[grid-area:close]"
          onClick={openConfirm}
        >
          <CloseIcon />
        </Button>
        <div
          role="img"
          aria-label={`Progress: ${passed} of ${total} cards`}
          className="flex min-w-0 gap-1 [grid-area:prog]"
          data-testid="ss-prog"
        >
          {cards.map((c, i) => {
            const on = i < passed;
            return (
              <i
                key={i}
                data-section={c.section}
                data-on={on || undefined}
                className="relative h-1 flex-1 rounded-full bg-line"
              >
                <b
                  className={
                    `absolute inset-0 origin-left rounded-[inherit] ${SECTION_FILL[c.section]} ` +
                    (mode === "full" ? "transition-transform duration-base ease-out motion-reduce:transition-none " : "") +
                    (on ? "scale-x-100" : "scale-x-0")
                  }
                />
              </i>
            );
          })}
        </div>
        <p className="mono flex flex-wrap gap-1 text-ink-2 [grid-area:counts]" aria-live="polite">
          {countsText(counts)}
        </p>
        <p className="mono text-ink-3 [grid-area:time]" aria-label="Time in this session">
          {formatClock(secs)}
        </p>
      </div>

      {confirming && (
        <div
          role="group"
          aria-label="Stop the session?"
          className="mx-[var(--pad)] mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-solid border-line bg-surface px-3.5 py-2.5"
        >
          <p className="flex-[1_1_200px] text-[15px]">{STOP_TEXT}</p>
          <Button ref={keepRef} variant="secondary" size="sm" onClick={closeConfirm}>
            Keep going
          </Button>
          <Button variant="primary" size="sm" onClick={onStop}>
            Stop
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col items-center justify-start overflow-y-auto overflow-x-hidden px-[var(--pad)] pt-[clamp(12px,5vh,56px)] pb-4">
        <div className="relative w-full max-w-[640px] pt-[18px]">
          <Vitonen ref={capRef} size={40} state="idle" className="absolute top-0 left-[18px] z-[4]" />

            {toast && (
              <motion.p
                key={toast.id}
                role="status"
                data-testid="ss-toast"
                data-kind={toast.kind}
                data-leaving={toast.leaving || undefined}
                className="absolute top-0 right-0 z-[4] inline-flex items-center gap-2 rounded-full bg-[var(--btn)] px-3 py-1.5 text-[13px] text-[var(--btn-ink)] shadow-[var(--shadow-card)]"
                initial={toastMotion.initial}
                animate={
                  toast.leaving
                    ? { opacity: 0, transition: { duration: instant ? 0 : TOAST_OUT_MS / 1000, ease: "linear" } }
                    : { opacity: 1, y: 0, scale: 1, transition: toastMotion.transition }
                }
              >
                {toast.kind === "miss" ? (
                  MISS_TEXT
                ) : (
                  <>
                    <span>
                      {toast.concept} climbed to <b className="font-semibold">{RUNG_NAMES[clampRung(toast.rung)]}</b>
                    </span>
                    <Pips rung={toast.rung} tone="inverse" size="sm" />
                  </>
                )}
              </motion.p>
            )}

          <AnimatePresence>
            {streak >= PILL_FROM && (
              <motion.p
                ref={pillRef}
                key="pill"
                aria-live="polite"
                data-testid="ss-combo"
                data-hot={hot || undefined}
                className={
                  "absolute top-0 left-1/2 z-[4] inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-solid px-3 py-1 text-[13px] " +
                  (hot
                    ? "border-accent bg-accent-wash text-ink [&_svg]:text-accent"
                    : "border-line bg-surface text-ink-2 [&_svg]:text-ink-3") +
                  // On phones the toast and the pill share one row: the toast wins.
                  (toast ? " max-[699px]:invisible" : "")
                }
                style={{ x: "-50%" }}
                initial={full ? { opacity: 0, scale: 0.6 } : { opacity: 0 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={full ? { opacity: 0, scale: 0.8, transition: { duration: 0.16, ease: ease.out } } : { opacity: 0, transition: { duration: quick } }}
                transition={full ? { duration: 0.32, ease: [0.3, 1.4, 0.5, 1] } : { duration: quick }}
              >
                <Flame />
                <span>
                  <b className="font-semibold text-ink">
                    {streak}
                  </b>{" "}
                  in a row
                </span>
              </motion.p>
            )}
          </AnimatePresence>

          <div className="relative">{children}</div>
        </div>
      </div>

      <div className="w-full max-w-[688px] self-center px-[var(--pad)] pt-2 pb-[max(14px,env(safe-area-inset-bottom,0px))]">
        {actions}
        {hint ? <p className="mt-2 hidden text-center text-[13px] text-ink-3 min-[700px]:block">{hint}</p> : null}
      </div>
    </section>
  );
}

function clearAll(timers: ReturnType<typeof setTimeout>[]): void {
  timers.forEach(clearTimeout);
  timers.length = 0;
}

function clampRung(n: number): number {
  return Math.min(5, Math.max(0, Math.round(n)));
}

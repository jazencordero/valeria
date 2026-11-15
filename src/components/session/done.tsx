"use client";

/**
 * Session done: the screen after the last card of a bite or a practice run.
 * Source: prototype main-flow.html JS 3429-3508 (sessionDone) and CSS 739-756,
 * 1208-1233 (.ss-done, .sd-*, .fch, .fbar, .climbs, .cl).
 *
 * Plain props: `result` is what `result()` in src/lib/study/session.ts returns
 * at the end of a session; the page passes the forecast numbers, the week and
 * what comes next. Nothing is computed here except labels.
 *
 * Choreography (full motion): the cap jumps and fires confetti (70 pieces if
 * perfect, else 40), the crown drops in, stats pop and roll up from 0, the
 * forecast rolls from the old number while the bar grows from the old width,
 * the delta pops, climb rows slide in with their new pips popping, today's
 * dot pops (confetti on it when this session met the goal), then the buttons.
 * Calm: one 150 ms fade, final numbers at once, no confetti. Instant: nothing
 * moves. Change the component's `key` to play it again.
 */
import { motion, type MotionProps } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Doodle } from "@/components/doodle";
import { Pips, RUNG_NAMES } from "@/components/study/pips";
import { StudyDays } from "@/components/study/study-days";
import { Button } from "@/components/ui/button";
import { burst } from "@/components/ui/confetti";
import { RollingNumber } from "@/components/ui/rolling-number";
import { Vitonen } from "@/components/vitonen";
import { calmDuration, ease } from "@/lib/motion/tokens";
import { useMotionMode, type MotionMode } from "@/lib/motion/use-calm";
import { gradeFor } from "@/lib/study/forecast";
import { rungOf } from "@/lib/study/ladder";
import type { SessionMode, SessionResult } from "@/lib/study/session";
import type { Week } from "@/lib/study/week";

export type DoneConcept = { name: string; icon?: ReactNode };

export type SessionDoneProps = {
  /** From `result()` at the end of the session. */
  result: SessionResult;
  mode: SessionMode;
  /** Exam short name, shown upper case: "<SHORT> · FORECAST". */
  examShort: string;
  /** Forecast percent before and after the session. */
  forecastBefore: number;
  forecastAfter: number;
  /** Target percent; the tick reads "A <grade>". */
  target: number;
  /** Where a bite a day lands on exam day, percent. */
  planEnd: number;
  /** Exam weekday, for example "Friday". */
  examDay: string;
  /** Names (and optional icons) for the concept ids in `result.climbs`. */
  concepts: Readonly<Record<string, DoneConcept>>;
  /** This week after the session (today already counted). */
  week: Week;
  weeksInARow: number;
  freeSkipsLeft: number;
  /** This session was the first today: today's dot pops in. */
  dayNew: boolean;
  /** This session met the week's goal: confetti on today's dot. */
  goalNew: boolean;
  /** Minutes of the next bite, or null when today's bites are done. */
  nextBiteMinutes: number | null;
  /** Label of the way back, for example "Back to the exam". */
  backLabel: string;
  onMore?: () => void;
  onBack?: () => void;
  /** Move focus to the title on mount. Default true. */
  focusTitle?: boolean;
  className?: string;
};

const LABEL =
  "mono mt-5 mb-2 text-left font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]";

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const clampPct = (n: number) => Math.min(100, Math.max(0, n));

/** Entrance with a delay in seconds; calm fades, instant shows. */
function enter(
  mode: MotionMode,
  from: Record<string, number | string>,
  to: Record<string, number | string>,
  transition: MotionProps["transition"],
): MotionProps {
  if (mode === "instant") return { initial: false };
  if (mode === "calm") {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      transition: { duration: calmDuration, ease: "linear" },
    };
  }
  return { initial: from, animate: to, transition };
}

const out = (duration: number, delay: number) => ({ duration, delay, ease: ease.out });
const spring = (bounce: number, visualDuration: number, delay: number) => ({
  type: "spring" as const,
  bounce,
  visualDuration,
  delay,
});

/** Calls `fn` after `ms` while full motion is on; cleared on unmount. */
function useAfter(on: boolean, ms: number, fn: () => void) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    if (!on) return;
    const t = window.setTimeout(() => ref.current(), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
}

export function SessionDone({
  result,
  mode: sessionMode,
  examShort,
  forecastBefore,
  forecastAfter,
  target,
  planEnd,
  examDay,
  concepts,
  week,
  weeksInARow,
  freeSkipsLeft,
  dayNew,
  goalNew,
  nextBiteMinutes,
  backLabel,
  onMore,
  onBack,
  focusTitle = true,
  className = "",
}: SessionDoneProps) {
  const motionMode = useMotionMode();
  const full = motionMode === "full";
  const isBite = sessionMode === "bite";
  const more = isBite && nextBiteMinutes !== null;

  const title = result.perfect ? "Perfect bite." : isBite ? "Bite done." : "Nice practice.";
  const delta = forecastAfter - forecastBefore;
  const before = clampPct(forecastBefore);
  const after = clampPct(forecastAfter);

  const titleRef = useRef<HTMLHeadingElement>(null);
  const capRef = useRef<HTMLSpanElement>(null);
  const daysRef = useRef<HTMLDivElement>(null);
  const climbsRef = useRef<HTMLUListElement>(null);

  // Numbers that roll: false shows the start value, true the final one.
  const [rolled, setRolled] = useState({ cards: false, best: false, forecast: false });
  const roll = (k: keyof typeof rolled) => setRolled((r) => ({ ...r, [k]: true }));
  useAfter(full, 200, () => roll("cards"));
  useAfter(full, 360, () => roll("best"));
  useAfter(full, 520, () => roll("forecast"));
  const shown = full ? rolled : { cards: true, best: true, forecast: true };

  useEffect(() => {
    if (focusTitle) titleRef.current?.focus({ preventScroll: true });
  }, [focusTitle]);

  // Cap jump, then confetti from it.
  useEffect(() => {
    const cap = capRef.current;
    if (!full || !cap || typeof cap.animate !== "function") return;
    let gone = false;
    const up = cap.animate(
      [{ transform: "translateY(0px)" }, { transform: "translateY(-18px)" }],
      { duration: 180, easing: `cubic-bezier(${ease.out.join(",")})`, fill: "forwards" },
    );
    let down: Animation | null = null;
    up.finished
      .then(() => {
        if (gone) return;
        down = cap.animate(
          [{ transform: "translateY(-18px)" }, { transform: "translateY(0px)" }],
          { duration: 360, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
        );
        up.cancel();
        burst(cap, result.perfect ? 70 : 40);
      })
      .catch(() => {});
    return () => {
      gone = true;
      up.cancel();
      down?.cancel();
    };
  }, [full, result.perfect]);

  // New pips pop inside each climb row.
  useEffect(() => {
    const list = climbsRef.current;
    if (!full || !list) return;
    const anims: Animation[] = [];
    list.querySelectorAll("li").forEach((li, i) => {
      li.querySelectorAll<HTMLElement>('[data-state="new"]').forEach((p, k) => {
        if (typeof p.animate !== "function") return;
        anims.push(
          p.animate([{ transform: "scale(0)" }, { transform: "scale(1)" }], {
            duration: 320,
            delay: 960 + i * 90 + k * 70,
            easing: "cubic-bezier(0.34, 1.8, 0.64, 1)",
            fill: "backwards",
          }),
        );
      });
    });
    return () => anims.forEach((a) => a.cancel());
  }, [full]);

  // Confetti on today's dot when this session met the goal.
  useAfter(full && dayNew && goalNew, 1450, () => {
    const i = week.days.findIndex((d) => d.isToday);
    const dot = daysRef.current?.querySelector('[role="img"]')?.children[i]?.firstElementChild;
    burst(dot ?? null, 24);
  });

  const stats = [
    {
      key: "cards",
      value: shown.cards ? result.cards : 0,
      label: result.cards === 1 ? "card" : "cards",
      roll: true,
    },
    { key: "time", value: clock(result.seconds), label: "time", roll: false },
    { key: "best", value: shown.best ? result.best : 0, label: "best streak", roll: true },
  ];

  return (
    <div
      className={`pt-2 pb-4 text-center ${className}`}
      data-session-done=""
    >
      <motion.div {...enter(motionMode, { opacity: 0, y: 8 }, { opacity: 1, y: 0 }, out(0.28, 0))}>
        <div className="relative mx-auto grid h-[104px] w-[120px] place-items-end-center">
          <motion.span
            aria-hidden="true"
            className="absolute -inset-2.5 rounded-full bg-[radial-gradient(circle,var(--butter)_0_40%,transparent_70%)] opacity-0"
            {...(full
              ? {
                  initial: { opacity: 0.9, scale: 0.3 },
                  animate: { opacity: 0, scale: 1.6 },
                  transition: out(0.7, 0.12),
                }
              : {})}
          />
          <span ref={capRef} className="relative inline-block">
            <Vitonen size={92} state="idle" />
          </span>
          {result.perfect ? (
            <motion.span
              data-crown=""
              className="absolute -top-3.5 left-1/2 leading-none"
              {...(full
                ? {
                    initial: { opacity: 0, x: "-50%", y: -30, rotate: -20 },
                    animate: { opacity: 1, x: "-50%", y: 0, rotate: -8 },
                    transition: spring(0.45, 0.42, 0.38),
                  }
                : { initial: false, style: { x: "-50%", rotate: -8 } })}
            >
              <Doodle name="crown" size={44} />
            </motion.span>
          ) : null}
        </div>

        <h2
          ref={titleRef}
          tabIndex={-1}
          className="mt-3 font-display text-[26px] font-semibold leading-[1.2] text-ink [font-variation-settings:'SOFT'_100]"
        >
          {title}
        </h2>

        <div className="my-5 grid grid-cols-3 gap-2">
          {stats.map((s, i) => (
            <motion.div
              key={s.key}
              className="grid gap-0.5 rounded-2xl border border-solid border-line bg-surface px-2 py-3"
              {...enter(
                motionMode,
                { opacity: 0, scale: 0.85 },
                { opacity: 1, scale: 1 },
                spring(0.3, 0.3, 0.12 + i * 0.08),
              )}
            >
              {s.roll ? (
                <b className="font-display text-[26px] font-semibold leading-[1.1] text-ink [font-variation-settings:'SOFT'_100]">
                  <RollingNumber value={s.value} />
                </b>
              ) : (
                <b className="font-mono text-[20px] font-medium leading-[1.1] text-ink">
                  {s.value}
                </b>
              )}
              <span className="text-[12px] text-ink-2">{s.label}</span>
            </motion.div>
          ))}
        </div>

        <section className="mt-1 rounded-[20px] bg-accent-wash p-4 text-left">
          <p className="mono mb-1 font-medium uppercase tracking-[0.04em] text-ink-2">
            {examShort.toUpperCase()} · FORECAST
          </p>
          <div className="flex items-baseline gap-2.5">
            <span className="font-display text-[48px] font-semibold leading-none tracking-[-0.02em] text-ink [font-variation-settings:'SOFT'_100]">
              <RollingNumber value={`${shown.forecast ? forecastAfter : forecastBefore}%`} />
            </span>
            {delta > 0 ? (
              <motion.span
                className="inline-block rounded-full bg-mint px-2.5 py-[3px] font-mono text-[14px] font-medium text-ink"
                {...enter(
                  motionMode,
                  { opacity: 0, scale: 0.4, y: 6 },
                  { opacity: 1, scale: 1, y: 0 },
                  spring(0.5, 0.36, 0.9),
                )}
              >
                +{delta}
              </motion.span>
            ) : null}
          </div>
          <div
            className="relative mt-4 mb-[26px] h-3 rounded-full bg-surface"
            role="img"
            aria-label={`Forecast ${forecastAfter}%, was ${forecastBefore}%, target ${target}%`}
          >
            <span
              data-ghost=""
              className="absolute inset-y-0 left-0 rounded-full bg-[color-mix(in_oklch,var(--ink)_18%,transparent)]"
              style={{ width: `${before}%` }}
            />
            <motion.span
              data-fill=""
              className="absolute inset-y-0 left-0 rounded-full bg-accent"
              style={{ width: `${after}%` }}
              {...(full
                ? {
                    initial: { width: `${before}%` },
                    animate: { width: `${after}%` },
                    transition: out(0.7, 0.5),
                  }
                : {})}
            />
            <i
              className="absolute -top-1 -bottom-1 -ml-px w-0.5 rounded-[2px] bg-ink"
              style={{ left: `${clampPct(target)}%` }}
            >
              <span className="mono absolute top-[22px] left-1/2 -translate-x-1/2 whitespace-nowrap !text-[10px] text-ink-2">
                A {gradeFor(target)}
              </span>
            </i>
          </div>
          <p className="text-[13px] text-ink-2">
            Keep a bite a day and you land around <b className="text-ink">{planEnd}%</b> on{" "}
            {examDay}.
          </p>
        </section>

        {result.climbs.length ? (
          <>
            <h3 className={LABEL}>WHAT MOVED</h3>
            <ul ref={climbsRef} className="grid list-none gap-1 p-0 text-left">
              {result.climbs.map((c, i) => {
                const r0 = rungOf(c.from);
                const r1 = rungOf(c.to);
                const up = r1 > r0;
                const info = concepts[c.concept];
                return (
                  <motion.li
                    key={c.concept}
                    data-up={up || undefined}
                    className={
                      "grid grid-cols-[32px_minmax(0,1fr)_auto_auto] items-center gap-x-2.5 rounded-[14px] px-2.5 py-2 " +
                      (up ? "bg-butter" : "")
                    }
                    {...enter(motionMode, { opacity: 0, x: -8 }, { opacity: 1, x: 0 }, out(0.24, 0.76 + i * 0.09))}
                  >
                    <span className="grid size-8 place-items-center rounded-[10px] bg-surface text-ink">
                      {info?.icon ?? (
                        <span className="font-display text-[14px] font-semibold" aria-hidden="true">
                          {(info?.name ?? c.concept).charAt(0)}
                        </span>
                      )}
                    </span>
                    <span className="grid min-w-0 text-[14px] font-semibold text-ink">
                      <span className="truncate">{info?.name ?? c.concept}</span>
                      <span className="mono !text-[11px] font-normal text-ink-2">
                        {up ? `${RUNG_NAMES[r0]} → ${RUNG_NAMES[r1]}` : RUNG_NAMES[r1]}
                      </span>
                    </span>
                    <Pips rung={r1} newFrom={r0} />
                    <span className="mono text-ink-2">
                      +{Math.max(1, Math.round((c.to - c.from) * 100))}%
                    </span>
                  </motion.li>
                );
              })}
            </ul>
          </>
        ) : null}

        <div ref={daysRef} className="mt-5 text-left">
          <StudyDays
            week={week}
            weeksInARow={weeksInARow}
            freeSkipsLeft={freeSkipsLeft}
            popToday={dayNew}
            popDelay={1.2}
          />
        </div>

        {/* The way out stays on screen on a phone: pinned to the bottom of the
            scrolling done screen, the content scrolls above it. */}
        <motion.div
          data-testid="session-done-actions"
          className="sticky bottom-0 z-[1] -mx-[var(--pad)] mt-5 grid gap-2 bg-paper px-[var(--pad)] pt-3 pb-[max(12px,env(safe-area-inset-bottom,0px))] shadow-[0_-12px_12px_-8px_var(--paper)] min-[700px]:grid-cols-2"
          {...enter(motionMode, { opacity: 0, y: 10 }, { opacity: 1, y: 0 }, out(0.26, 1.1))}
        >
          {more ? (
            <Button variant="secondary" size="lg" onClick={onMore}>
              One more bite · {nextBiteMinutes} min
            </Button>
          ) : (
            <p className="m-0 flex items-center justify-center gap-3 text-[13px] text-ink-2">
              <Doodle name="cup" size={48} />
              <span>
                {isBite
                  ? "That is today's plan done. Rest counts too."
                  : "Nice. Your bites are still waiting on the exam page."}
              </span>
            </p>
          )}
          <Button variant="primary" size="lg" onClick={onBack}>
            {more ? "Done for now" : backLabel}
          </Button>
        </motion.div>
      </motion.div>
    </div>
  );
}

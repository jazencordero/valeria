"use client";

/**
 * The tutor chat's two small controls (M2-28 follow-up): the model picker beside "Ask", and the
 * usage chip at the top of the chat with its popover. Pure views with plain props; the chat
 * (tutor-chat.tsx) loads the data and keeps the choice.
 *
 * Picker: three levels in plain words, "Quick" (the small Claude model, the default),
 * "Balanced" (the middle one) and "Deep" (Claude Fable 5.2), each with a one-line hint and a
 * cost mark. The marks are 1, 3 and 4 dots: 1 + round(log2(price ratio) / 2) on the real price
 * ratios 1 : 20 : 80 (src/server/tutor/budget.ts, `costDots`, tested equal). It is a native
 * radio group in a fieldset, so arrow keys move the choice and a screen reader reads the group's
 * name, each level, its cost and its hint. With no key or no budget left it is one disabled
 * line, `FREE_LEVEL_LINE`.
 *
 * Usage chip: a thin ring of this month's tutor budget used (all users, one budget) and the
 * percentage; amber from 80%, never red. It is a button whose name carries the numbers. It
 * opens a popover (a non-modal dialog) with the bar, used and left ("Less than 1 of 150 EUR
 * used. About 149 EUR left."), roughly how many answers are left at each level (a conservative
 * default until she has 30 answers at a level, then blended; src/server/tutor/budget.ts,
 * `answersLeftFor`; two significant figures), the reset date and what happens at zero, plus a
 * small line that these are estimates. Escape or a tap outside closes it, and focus
 * goes back to the chip. With reduced motion the ring and bar do not animate.
 */
import { useEffect, useId, useRef } from "react";
import type { TutorLevel, TutorMeter } from "@/server/tutor/budget";

export type { TutorLevel, TutorMeter };

export const LEVELS: readonly TutorLevel[] = ["quick", "balanced", "deep"];
export const DEFAULT_LEVEL: TutorLevel = "quick";
export const FREE_LEVEL_LINE = "Free model this month";
export const ZERO_LINE = "At zero, answers come from the free models until it resets.";
export const ESTIMATE_LINE = "Estimates from this month's token counts, not a bill.";
/** From this share of the budget the chip and bar turn amber. */
export const AMBER_FROM = 0.8;

export const LEVEL_CHOICES: Record<TutorLevel, { label: string; hint: string; dots: number; cost: string }> = {
  quick: { label: "Quick", hint: "Fast, short answers. Good for most questions.", dots: 1, cost: "lowest cost" },
  balanced: { label: "Balanced", hint: "More care with harder ideas.", dots: 3, cost: "about 20 times the cost of Quick" },
  deep: { label: "Deep", hint: "The strongest model, for the hardest questions.", dots: 4, cost: "about 80 times the cost of Quick" },
};

/** This device's last choice. */
export const LEVEL_KEY = "ready.tutor.level";

export function readLevel(): TutorLevel {
  try {
    const v = window.localStorage.getItem(LEVEL_KEY);
    return LEVELS.includes(v as TutorLevel) ? (v as TutorLevel) : DEFAULT_LEVEL;
  } catch {
    return DEFAULT_LEVEL;
  }
}

export function rememberLevel(level: TutorLevel): void {
  try {
    window.localStorage.setItem(LEVEL_KEY, level);
  } catch {
    // Storage blocked: the choice lasts until the chat closes.
  }
}

// ---------------------------------------------------------------------------
// Picker

function Dots({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="flex gap-[3px]" data-testid="tutor-level-dots">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="block h-[4px] w-[4px] rounded-full bg-current" />
      ))}
    </span>
  );
}

export function LevelPicker(props: { level: TutorLevel; available: boolean; disabled?: boolean; onLevel: (level: TutorLevel) => void }) {
  const name = useId();
  const hintId = useId();
  if (!props.available) {
    return (
      <p
        className="m-0 flex min-h-[44px] flex-1 items-center rounded-[12px] border border-dashed border-line px-3 text-[13px] text-ink-3"
        aria-disabled="true"
        data-testid="tutor-level-free"
      >
        {FREE_LEVEL_LINE}
      </p>
    );
  }
  return (
    <fieldset className="m-0 min-w-0 flex-1 border-0 p-0" data-testid="tutor-levels">
      <legend className="sr-only">Answer model</legend>
      <div className="grid grid-cols-3 gap-1 rounded-[12px] border border-line bg-paper p-[3px]">
        {LEVELS.map((level) => {
          const c = LEVEL_CHOICES[level];
          return (
            <label
              key={level}
              className={
                "relative flex min-h-[38px] cursor-pointer flex-col items-center justify-center gap-[3px] rounded-[9px] px-1 text-[13px] text-ink-2 " +
                "has-[:checked]:bg-surface has-[:checked]:text-ink has-[:checked]:shadow-[0_0_0_1px_var(--line)] " +
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-[var(--accent)] " +
                "has-[:disabled]:cursor-default"
              }
              data-testid={`tutor-level-${level}`}
            >
              <input
                type="radio"
                name={name}
                value={level}
                checked={props.level === level}
                disabled={props.disabled}
                onChange={() => props.onLevel(level)}
                aria-describedby={props.level === level ? hintId : undefined}
                className="sr-only"
              />
              <span className="leading-none">
                {c.label}
                <span className="sr-only">, {c.cost}</span>
              </span>
              <Dots n={c.dots} />
            </label>
          );
        })}
      </div>
      <p id={hintId} className="m-0 truncate pt-1 text-[12px] text-ink-3" data-testid="tutor-level-hint">
        {LEVEL_CHOICES[props.level].hint}
      </p>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Usage chip and popover

/**
 * Roughly `n`: two significant figures, with thousands commas ("296,442" -> "300,000",
 * "14,822" -> "15,000", "2,264" -> "2,300"; under 100 it is the number itself).
 */
export function roughCount(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v < 100) return String(v);
  const p = 10 ** (String(v).length - 2);
  return (Math.round(v / p) * p).toLocaleString("en-US");
}

const budgetText = (b: number) => (Number.isInteger(b) ? String(b) : b.toFixed(2));

/** "2026-12-01" -> "1 Dec". */
export function resetDay(resetsOn: string): string {
  const at = new Date(`${resetsOn}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return resetsOn;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(at);
}

/** Euros as she reads them, without "about" before an exact or a "less than" figure. */
function eurPhrase(eur: number, round: (n: number) => number): string {
  if (eur <= 0) return "0";
  if (eur < 1) return "less than 1";
  return `about ${round(eur)}`;
}

const sentence = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}.`;

/**
 * The sentences the chip and popover show. `used` (lower case, no full stop) is also the chip's
 * accessible name and the bar's value text: "about 12 of 150 EUR used", "less than 1 of 150 EUR
 * used". The popover reads "About 12 of 150 EUR used. About 138 EUR left." (left is rounded
 * down, so used + left never reads more than the budget).
 */
export function meterWords(m: TutorMeter) {
  const used = `${eurPhrase(m.usedEur, Math.round)} of ${budgetText(m.budgetEur)} EUR used`;
  const left = `${eurPhrase(Math.max(0, m.budgetEur - m.usedEur), Math.floor)} EUR left`;
  const l = m.levels;
  const levels =
    m.usedEur >= m.budgetEur
      ? "Nothing is left for Claude this month."
      : `That is roughly ${roughCount(l.quick.answersLeft)} Quick answers, ${roughCount(l.balanced.answersLeft)} Balanced, or ${roughCount(l.deep.answersLeft)} Deep ones.`;
  return {
    percent: `${Math.round(m.fraction * 100)}%`,
    used,
    left,
    usedSentence: sentence(used),
    leftSentence: sentence(left),
    levels,
    resets: `Resets ${resetDay(m.resetsOn)}.`,
    chipName: `Tutor allowance this month: ${used}. Show details`,
  };
}

const RING_R = 6;
const RING_C = 2 * Math.PI * RING_R;

function Ring({ fraction, amber }: { fraction: number; amber: boolean }) {
  const f = Math.min(1, Math.max(0, fraction));
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="flex-none -rotate-90">
      <circle cx="8" cy="8" r={RING_R} fill="none" stroke="var(--line)" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r={RING_R}
        fill="none"
        stroke={amber ? "var(--due)" : "var(--ink-2)"}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={RING_C}
        strokeDashoffset={RING_C * (1 - f)}
        className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
        data-testid="tutor-meter-ring"
      />
    </svg>
  );
}

export function UsageMeter(props: { meter: TutorMeter; open: boolean; onOpen: (open: boolean) => void }) {
  const { meter, open, onOpen } = props;
  const popId = useId();
  const titleId = useId();
  const chip = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const words = meterWords(meter);
  const amber = meter.fraction >= AMBER_FROM;

  // Open: focus the popover. Escape or a tap outside closes it, focus back on the chip.
  useEffect(() => {
    if (!open) return;
    pop.current?.focus();
    const close = () => {
      onOpen(false);
      chip.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && !pop.current?.contains(target) && !chip.current?.contains(target)) onOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, onOpen]);

  return (
    <div className="relative">
      <button
        ref={chip}
        type="button"
        aria-label={words.chipName}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => onOpen(!open)}
        className={
          "inline-flex min-h-[44px] cursor-pointer items-center border-0 bg-transparent p-0 focus-visible:outline-none " +
          "[&:focus-visible>span]:outline-2 [&:focus-visible>span]:outline-offset-2 [&:focus-visible>span]:outline-[var(--accent)]"
        }
        data-testid="tutor-meter"
        data-amber={amber ? "true" : undefined}
      >
        <span className={`inline-flex min-h-[28px] items-center gap-1.5 rounded-full border border-line bg-paper px-2.5 text-[12px] ${amber ? "text-due" : "text-ink-2"}`}>
          <Ring fraction={meter.fraction} amber={amber} />
          <span className="mono">{words.percent}</span>
        </span>
      </button>
      {open ? (
        <div
          ref={pop}
          id={popId}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="absolute top-full right-0 z-20 mt-1 w-[min(18rem,calc(100vw-2.5rem))] rounded-[14px] border border-line bg-surface p-3.5 text-[14px] leading-[1.45] text-ink shadow-[0_8px_24px_rgb(0_0_0/0.12)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          data-testid="tutor-meter-popover"
        >
          <p id={titleId} className="m-0 text-[13px] font-semibold">
            Tutor allowance this month
          </p>
          <div
            role="meter"
            aria-valuemin={0}
            aria-valuemax={meter.budgetEur}
            aria-valuenow={Math.min(meter.usedEur, meter.budgetEur)}
            aria-valuetext={words.used}
            aria-label="Allowance used"
            className="mt-2 h-[6px] overflow-hidden rounded-full bg-line"
          >
            <div
              className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${Math.min(100, Math.max(0, meter.fraction * 100))}%`, background: amber ? "var(--due)" : "var(--ink-2)" }}
              data-testid="tutor-meter-bar"
            />
          </div>
          <p className="m-0 mt-2" data-testid="tutor-meter-used">
            <span className={amber ? "text-due" : undefined}>{words.usedSentence}</span> {words.leftSentence}
          </p>
          <p className="m-0 mt-1.5" data-testid="tutor-meter-levels">
            {words.levels}
          </p>
          <p className="m-0 mt-1.5" data-testid="tutor-meter-reset">
            {words.resets} {ZERO_LINE}
          </p>
          <p className="m-0 mt-2 text-[12px] text-ink-3">{ESTIMATE_LINE}</p>
        </div>
      ) : null}
    </div>
  );
}

"use client";

/**
 * Concept path (M3-26): "YOUR PATH" on the exam page. Source: prototype
 * main-flow.html JS 2830-2854 (pathHTML) and CSS 1070-1103 (.path, .pnode).
 *
 * A zig-zag of round nodes, one per concept in lecture order (x at 30% and
 * 70%, 112 px apart), joined by a curved dotted line. The accent part of the
 * line runs up to the last concept that has been started. Each node is toned
 * by rung (not started, 1-2 sky, 3-4 butter, 5 mint), with a ring of rung x
 * 20%, the concept icon, a crown at rung 5 and a NEXT tag on the focus
 * concept. Its label shows the name, "LECTURE N · W%", pips and rung name.
 *
 * Nodes are buttons in one tab stop: arrow keys move between them, Enter or
 * Space selects (`onSelect(conceptId)`). The page decides every number,
 * including which concept is the focus (see focusConcept in lib/study/ladder).
 *
 * First show: the line draws and the nodes pop in 90 ms apart. Calm: a 150 ms
 * fade, no stagger, no pulse.
 */
import { motion } from "motion/react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Doodle } from "@/components/doodle";
import { ConceptIcon, iconFor, type ConceptIconName } from "@/components/exams/concept-icons";
import { Pips, RUNG_NAMES } from "@/components/study/pips";
import { rungOf, type RungLevel } from "@/lib/study/ladder";
import { calmDuration, duration, ease, rewardSpring } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

export type PathConcept = {
  id: string;
  name: string;
  /** Lecture number, 1-based. */
  lecture: number;
  /** Share of the exam, 0..1. */
  weight: number;
  /** Mastery as it stands today, 0..1 (labelled "now"). The rung comes from it. */
  mastery: number;
  /** Defaults to iconFor(name). */
  icon?: ConceptIconName;
};

export type ConceptPathProps = {
  /** In lecture order. */
  concepts: readonly PathConcept[];
  /** The concept to study next: gets the NEXT tag and the pulse. */
  focusId?: string | null;
  /** The open concept: outlined, and aria-expanded when `detailsId` is given. */
  selectedId?: string | null;
  /** Id of the detail panel the nodes open, for aria-controls. */
  detailsId?: string;
  onSelect?: (conceptId: string) => void;
  className?: string;
};

/** Distance between rows, px. */
export const ROW = 112;
const XS = [30, 70] as const;
const NODE = 68;

type Tone = "r0" | "r1" | "r3" | "r5";

export function toneOf(r: RungLevel): Tone {
  return r === 0 ? "r0" : r <= 2 ? "r1" : r <= 4 ? "r3" : "r5";
}

const DISC: Record<Tone, string> = {
  r0: "bg-paper border-[1.5px] border-dashed border-ink-3 text-ink-3",
  r1: "bg-sky shadow-[0_3px_0_color-mix(in_oklch,var(--ink)_14%,transparent)]",
  r3: "bg-butter shadow-[0_3px_0_color-mix(in_oklch,var(--ink)_14%,transparent)]",
  r5: "bg-mint shadow-[0_3px_0_color-mix(in_oklch,var(--ink)_14%,transparent)]",
};

type Pt = { x: number; y: number };

/** The curve through the first `upto + 1` points, in the 100-wide viewBox. */
export function pathD(pts: readonly Pt[], upto: number): string {
  if (!pts.length) return "";
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i <= upto && i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const my = (a.y + b.y) / 2;
    d += ` C${a.x} ${my} ${b.x} ${my} ${b.x} ${b.y}`;
  }
  return d;
}

// Bits Tailwind cannot say neatly: the focus pulse and the hover lift.
const CSS = `.cpn-node.focus::before{content:"";position:absolute;inset:-6px;border-radius:999px;background:var(--accent);opacity:.16;animation:cpn-pulse 2.4s var(--e-out) infinite}
@keyframes cpn-pulse{0%{transform:scale(.9);opacity:.28}70%{transform:scale(1.18);opacity:0}100%{opacity:0}}
.cpn-calm .cpn-node.focus::before{animation:none}
.cpn-disc{transition:transform var(--t-quick) var(--e-out)}
@media (hover:hover){.cpn-node:hover .cpn-disc{transform:translateY(-2px)}}
@media (prefers-reduced-motion:reduce){.cpn-node.focus::before{animation:none}.cpn-disc{transition:none}}`;

export function ConceptPath({
  concepts,
  focusId = null,
  selectedId = null,
  detailsId,
  onSelect,
  className = "",
}: ConceptPathProps) {
  const mode = useMotionMode();
  const labelId = useId();
  const full = mode === "full";
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  const n = concepts.length;

  const pts = concepts.map((_, i) => ({ x: XS[i % 2], y: i * ROW + 38 }));
  const h = n ? (n - 1) * ROW + 92 : 0;
  const rungs = concepts.map((c) => rungOf(c.mastery));
  let lastStarted = 0;
  rungs.forEach((r, i) => {
    if (r > 0) lastStarted = i;
  });

  // One tab stop: the selected node, else the focus one, else the first.
  const selIdx = concepts.findIndex((c) => c.id === selectedId);
  const focIdx = concepts.findIndex((c) => c.id === focusId);
  const fallback = selIdx >= 0 ? selIdx : Math.max(0, focIdx);
  const [active, setActive] = useState<number | null>(null);
  const tabIdx = active !== null && active < n ? active : fallback;

  function move(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let to: number | null = null;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") to = Math.min(n - 1, i + 1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") to = Math.max(0, i - 1);
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = n - 1;
    if (to === null) return;
    e.preventDefault();
    setActive(to);
    btns.current[to]?.focus();
  }

  const fadeT = { duration: mode === "instant" ? 0 : calmDuration, ease: "linear" as const };
  // The line always runs downward, so it "draws" by unclipping from the top.
  // (A dash offset would not line up: the stroke does not scale, the path does.)
  const lineAnim = full
    ? {
        initial: { clipPath: `inset(-8px -8px ${h + 8}px -8px)` },
        animate: { clipPath: "inset(-8px -8px -8px -8px)" },
        transition: { duration: 0.7, ease: ease.inout },
      }
    : { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: fadeT };
  const nodeAnim = (i: number) =>
    full
      ? {
          initial: { opacity: 0, scale: 0.6 },
          animate: { opacity: 1, scale: 1 },
          transition: {
            scale: { ...rewardSpring, delay: i * 0.09 },
            opacity: { duration: duration.quick, ease: ease.out, delay: i * 0.09 },
          },
        }
      : { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: fadeT };
  const labAnim = (i: number) =>
    full
      ? {
          initial: { opacity: 0 },
          animate: { opacity: 1 },
          transition: { duration: duration.base, ease: ease.out, delay: i * 0.09 + 0.04 },
        }
      : { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: fadeT };

  return (
    <section aria-labelledby={labelId} className={className}>
      <style href="ready-concept-path" precedence="default">
        {CSS}
      </style>
      <h2
        id={labelId}
        className="mono mb-3 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]"
      >
        YOUR PATH
      </h2>
      <p className="-mt-1 mb-3.5 text-[13px] text-ink-3">
        In lecture order. Each concept climbs five rungs: recognise, fill the gap, recall, explain,
        exam-ready.
      </p>

      <div className={`relative ${full ? "" : "cpn-calm"}`} style={{ height: h }} data-concept-path="">
        {n > 0 && (
          <svg
            className="absolute inset-0 h-full w-full overflow-visible"
            viewBox={`0 0 100 ${h}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d={pathD(pts, n - 1)}
              className="fill-none stroke-line"
              strokeWidth={6}
              strokeLinecap="round"
              strokeDasharray="2 10"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
        {lastStarted > 0 && (
          <motion.svg
            className="absolute inset-0 h-full w-full overflow-visible"
            viewBox={`0 0 100 ${h}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
            data-path-done=""
            {...lineAnim}
          >
            <path
              d={pathD(pts, lastStarted)}
              className="fill-none stroke-accent"
              strokeWidth={4}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              opacity={0.85}
            />
          </motion.svg>
        )}

        {concepts.map((c, i) => {
          const r = rungs[i];
          const tone = toneOf(r);
          const p = pts[i];
          const left = p.x < 50;
          const isFocus = c.id === focusId;
          const isSel = c.id === selectedId;
          const pct = Math.round(c.mastery * 100);
          return (
            <div key={c.id} className="absolute inset-x-0 h-[68px]" style={{ top: p.y - 34 }}>
              <motion.button
                ref={(el) => {
                  btns.current[i] = el;
                }}
                type="button"
                className={`cpn-node absolute top-0 grid size-[68px] place-items-center rounded-full p-0 text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink ${isFocus ? "focus" : ""}`}
                style={{ left: `calc(${p.x}% - ${NODE / 2}px)` }}
                tabIndex={i === tabIdx ? 0 : -1}
                data-concept={c.id}
                data-tone={tone}
                aria-label={`${c.name}, ${RUNG_NAMES[r]}, ${pct}% now`}
                aria-expanded={detailsId ? isSel : undefined}
                aria-controls={detailsId}
                onFocus={() => setActive(i)}
                onKeyDown={(e) => move(e, i)}
                onClick={() => onSelect?.(c.id)}
                {...nodeAnim(i)}
              >
                <svg
                  className="absolute inset-0 size-[68px] fill-none"
                  viewBox="0 0 36 36"
                  aria-hidden="true"
                  focusable="false"
                >
                  <circle className="stroke-line" cx="18" cy="18" r="16.5" strokeWidth={2.6} />
                  {r > 0 && (
                    <circle
                      className="stroke-accent"
                      cx="18"
                      cy="18"
                      r="16.5"
                      strokeWidth={2.6}
                      strokeLinecap="round"
                      pathLength={100}
                      strokeDasharray={`${r * 20} 100`}
                      transform="rotate(-90 18 18)"
                    />
                  )}
                </svg>
                <span
                  className={`cpn-disc relative grid size-[52px] place-items-center rounded-full ${DISC[tone]} ${isSel ? "outline-2 outline-offset-2 outline-ink" : ""}`}
                >
                  <ConceptIcon name={c.icon ?? iconFor(c.name)} size={24} />
                </span>
                {r === 5 && (
                  <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 -rotate-[8deg] leading-none">
                    <Doodle name="crown" size={26} />
                  </span>
                )}
                {isFocus && (
                  <span className="mono absolute -bottom-2.5 left-1/2 -translate-x-1/2 rounded-full bg-[var(--btn)] px-2 py-0.5 text-[10px] text-[var(--btn-ink)] shadow-[0_2px_0_var(--btn-ledge)]">
                    NEXT
                  </span>
                )}
              </motion.button>

              {/* The button already says all of this, so the label is hidden from screen readers. */}
              <motion.div
                aria-hidden="true"
                className={`absolute top-1.5 min-w-0 ${left ? "right-0 left-[calc(30%+46px)]" : "right-[calc(30%+46px)] left-0 text-right"}`}
                {...labAnim(i)}
              >
                <p className="text-[15px] leading-[1.25] font-semibold">{c.name}</p>
                <p className="mono mt-0.5 text-[11px] text-ink-3">
                  LECTURE {c.lecture} · {Math.round(c.weight * 100)}%
                </p>
                <p
                  className={`mt-1 inline-flex items-center gap-1.5 text-xs text-ink-2 ${left ? "" : "flex-row-reverse"}`}
                >
                  <Pips rung={r} />
                  <span>{RUNG_NAMES[r]}</span>
                </p>
              </motion.div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

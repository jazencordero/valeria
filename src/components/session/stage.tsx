"use client";

/**
 * The session stage (M3-37): holds the current card on a soft stack and moves
 * cards on and off it. Source: prototype main-flow.html JS 3409-3428 (the
 * graded card's exit) and the `.sc`, `.sc-edge` and `.sc.leaving` rules in
 * CSS 667-769.
 *
 *   <SessionStage cardKey={card.id} after={queue.length - 1} exit={lastGrade}
 *     boss={card.section === "boss"} onBossEnter={() => frame.current?.react("cheer")}>
 *     <CardBasic card={card} … />
 *   </SessionStage>
 *
 * Change `cardKey` to move on, and set `exit` in the same render to say how the
 * card that was showing leaves:
 *   pass  lifts 40 px and turns 4 degrees, above the next card;
 *   hard  nudges 8 px down, above the next card;
 *   miss  sinks 12 px and shrinks to 0.94, behind the next card.
 * Each exit fades out in 120 ms first; the move runs on its own (220 ms, or
 * 280 ms for a miss), so the two cards never read as doubled text. The next
 * card is already in place beneath: no empty frame.
 * Edges behind the card: one when 1 card remains after this one, two when 2
 * or more. A boss card enters on a bigger spring, pops its crown, and calls
 * `onBossEnter` so the cap can cheer. Calm: cross-fade only. Instant (the
 * test switch): no motion at all. Presentational: no swipe gestures.
 */
import { AnimatePresence, motion, useIsPresent, type Transition, type Variants } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { calmDuration, ease } from "@/lib/motion/tokens";
import { useMotionMode, type MotionMode } from "@/lib/motion/use-calm";

export type StageExit = "pass" | "hard" | "miss";

export type SessionStageProps = {
  /** Identity of the current card; a new value moves the old card off. */
  cardKey: string;
  /** How many cards remain after this one: 1 shows one edge, 2+ shows two. */
  after: number;
  /** How the card that was showing leaves when `cardKey` changes. Default "pass". */
  exit?: StageExit;
  /** The current card is the boss question. */
  boss?: boolean;
  /** Called once when a boss card arrives (not on first mount): ask the cap to cheer. */
  onBossEnter?: () => void;
  /** The current card. */
  children: ReactNode;
  className?: string;
};

/** The fade that runs before the move. */
export const EXIT_FADE_MS = 120;
/** How long each exit's move runs. */
export const EXIT_MOVE_MS: Record<StageExit, number> = { pass: 220, hard: 220, miss: 280 };

type Custom = { exit: StageExit; boss: boolean; mode: MotionMode };

const EXIT_TO: Record<StageExit, { y: number; rotate: number; scale: number }> = {
  pass: { y: -40, rotate: 4, scale: 1 },
  hard: { y: 8, rotate: 0, scale: 1 },
  miss: { y: 12, rotate: 0, scale: 0.94 },
};

/** A small settle for ordinary cards; the boss gets a bigger, bouncier one. */
const ENTER_SPRING: Transition = { type: "spring", bounce: 0.2, visualDuration: 0.3 };
const BOSS_SPRING: Transition = { type: "spring", bounce: 0.45, visualDuration: 0.5 };

const variants: Variants = {
  enter: ({ boss, mode }: Custom) =>
    mode === "full"
      ? boss
        ? { opacity: 1, y: 18, scale: 0.9, rotate: 0, zIndex: 2 }
        : { opacity: 1, y: 6, scale: 0.97, rotate: 0, zIndex: 2 }
      : { opacity: 0, y: 0, scale: 1, rotate: 0, zIndex: 2 },
  center: ({ boss, mode }: Custom) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    rotate: 0,
    zIndex: 2,
    transition: {
      default:
        mode === "full"
          ? boss
            ? BOSS_SPRING
            : ENTER_SPRING
          : { duration: mode === "instant" ? 0 : calmDuration, ease: "linear" },
      zIndex: { duration: 0 },
    },
  }),
  leave: ({ exit, mode }: Custom) => {
    if (mode !== "full") {
      return {
        opacity: 0,
        zIndex: 5,
        transition: {
          default: { duration: mode === "instant" ? 0 : calmDuration, ease: "linear" },
          zIndex: { duration: 0 },
        },
      };
    }
    const to = EXIT_TO[exit];
    const move: Transition = {
      duration: EXIT_MOVE_MS[exit] / 1000,
      ease: exit === "miss" ? ease.inout : ease.out,
    };
    return {
      ...to,
      opacity: 0,
      // A miss sinks behind the next card; pass and hard leave above it.
      zIndex: exit === "miss" ? 1 : 5,
      transition: {
        opacity: { duration: EXIT_FADE_MS / 1000, ease: ease.out },
        y: move,
        rotate: move,
        scale: move,
        zIndex: { duration: 0 },
      },
    };
  },
};

/** Takes the leaving card out of reach: no focus, no clicks, hidden from screen readers. */
function Layer({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  return (
    <div
      inert={!present}
      aria-hidden={present ? undefined : true}
      data-leaving={present ? undefined : true}
      className={present ? undefined : "pointer-events-none"}
    >
      {children}
    </div>
  );
}

const CROWN_POP: Keyframe[] = [
  { transform: "scale(0) rotate(-20deg)", opacity: 0 },
  { transform: "scale(1.25) rotate(6deg)", opacity: 1, offset: 0.6 },
  { transform: "scale(1) rotate(0deg)", opacity: 1 },
];

export function SessionStage({
  cardKey,
  after,
  exit = "pass",
  boss = false,
  onBossEnter,
  children,
  className = "",
}: SessionStageProps) {
  const mode = useMotionMode();
  const full = mode === "full";
  const edges = after >= 2 ? 2 : after >= 1 ? 1 : 0;
  const custom: Custom = { exit, boss, mode };
  const cardsRef = useRef<HTMLDivElement>(null);

  const latestBoss = useRef(onBossEnter);
  useEffect(() => {
    latestBoss.current = onBossEnter;
  });

  // A boss arriving (not the first card): pop the crown in its head, ask for a cheer.
  const lastKey = useRef(cardKey);
  useEffect(() => {
    if (cardKey === lastKey.current) return;
    lastKey.current = cardKey;
    if (!boss) return;
    latestBoss.current?.();
    if (!full) return;
    const crown = cardsRef.current?.querySelector<SVGElement>(
      `[data-stage-key="${CSS.escape(cardKey)}"] [data-testid="sc-label"] svg`,
    );
    if (crown && typeof crown.animate === "function") {
      crown.style.transformOrigin = "50% 70%";
      crown.animate(CROWN_POP, { duration: 520, delay: 120, easing: "cubic-bezier(.3,1.4,.5,1)", fill: "backwards" });
    }
  }, [cardKey, boss, full]);

  const edgeMotion = full
    ? { duration: 0.22, ease: ease.out }
    : { duration: mode === "instant" ? 0 : calmDuration, ease: "linear" as const };

  return (
    <div className={"relative " + className} data-testid="ss-stage" data-edges={edges}>
      <AnimatePresence initial={false}>
        {edges >= 2 && (
          <motion.div
            key="e2"
            aria-hidden="true"
            data-testid="sc-edge"
            className="absolute inset-0 z-0 origin-bottom rounded-[24px] border border-solid border-line bg-surface"
            style={{ y: 12, scale: 0.94 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.45 }}
            exit={{ opacity: 0 }}
            transition={edgeMotion}
          />
        )}
        {edges >= 1 && (
          <motion.div
            key="e1"
            aria-hidden="true"
            data-testid="sc-edge"
            className="absolute inset-0 z-[1] origin-bottom rounded-[24px] border border-solid border-line bg-surface"
            style={{ y: 6, scale: 0.97 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.75 }}
            exit={{ opacity: 0 }}
            transition={edgeMotion}
          />
        )}
      </AnimatePresence>

      <div ref={cardsRef} className="relative z-[2]">
        <AnimatePresence initial={false} mode="popLayout" custom={custom}>
          <motion.div
            key={cardKey}
            data-stage-key={cardKey}
            data-boss={boss || undefined}
            className="relative origin-bottom"
            custom={custom}
            variants={variants}
            initial="enter"
            animate="center"
            exit="leave"
          >
            <Layer>{children}</Layer>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

"use client";

/**
 * Choose your school (M5-04). Source: prototype main-flow.html HTML 1287-1311
 * (#v-school), CSS 256-279 (.schools, .school, .sch-*, .say-row, .bubble) and
 * JS 2249-2263 (pickSchool).
 *
 * Back arrow (to /welcome), "Where do you study?", one radio card per school
 * (letter circle, name, place; the picked one gets an ink border and a check
 * that pops), "More schools soon". At the foot the cap with a speech bubble
 * that types the school's quip when she picks one, and Continue, disabled
 * until she has picked.
 *
 * A school that is not enabled yet (LUT) can be picked, but the button then
 * says "Tell me when LUT is ready"; pressing it makes the cap say
 * "Not yet. Aalto works today." No waiting list (ticket Cut).
 *
 * Keyboard: the cards are one radio group with a roving tab stop. Arrow keys
 * move to the next or previous card and pick it, wrapping round; Home and End
 * go to the first and last. Space and Enter pick the focused card.
 *
 * Motion: the screen arrives from 16 px to the right with a fade, and leaves
 * the same way it goes: 16 px to the left on Continue, 16 px to the right on
 * Back. Calm: fades only, 150 ms. The fast test switch: no motion. Coming
 * back to it with browser back, it slides in from the side it left by.
 *
 * Plain props: `schools` (from src/lib/schools.ts, picked by the page) and
 * `choose`, which stores the pick (`chooseSchoolAction`) and answers `{ ok }`.
 */
import { motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Typewriter } from "@/components/ui/typewriter";
import { Vitonen } from "@/components/vitonen";
import { calmDuration, duration, ease, rewardSpring } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

export type SchoolTone = "butter" | "mint";

export type SchoolCard = {
  id: string;
  /** Short name, as in "LUT" (for "Tell me when LUT is ready"). */
  name: string;
  /** Full name, as in "LUT University". */
  full: string;
  /** Where it is, as in "Lappeenranta and Lahti". */
  where: string;
  /** The line the cap says when she picks it. */
  quip: string;
  /** Whether she can connect to it now. */
  enabled: boolean;
  tone: SchoolTone;
};

export type SchoolPickProps = {
  schools: readonly SchoolCard[];
  /** Stores her pick on her user. Only called for an enabled school. */
  choose: (schoolId: string) => Promise<{ ok: boolean }>;
  /** Where Back goes. Default /welcome. */
  backHref?: string;
  /** Where Continue goes after the pick is stored. Default /connect. */
  nextHref?: string;
};

const TONE: Record<SchoolTone, string> = { butter: "bg-butter", mint: "bg-mint" };
const SLIDE_PX = 16;
/** Longest a slide out is waited for: the base duration plus room. */
const SLIDE_FALLBACK_MS = 600;

const BackIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="ic">
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </svg>
);

const CheckIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="ic !size-3.5 ![stroke-width:2]">
    <path d="M6 12.5l4 4L18 8" />
  </svg>
);

type Leaving = null | "forward" | "back";

export function SchoolPick({ schools, choose, backHref = "/welcome", nextHref = "/connect" }: SchoolPickProps) {
  const router = useRouter();
  const mode = useMotionMode();
  const [picked, setPicked] = useState<string | null>(null);
  const [say, setSay] = useState<string | null>(null);
  const [talking, setTalking] = useState(false);
  const [leaving, setLeaving] = useState<Leaving>(null);
  const [pending, startTransition] = useTransition();
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  /** Ends the slide out's wait; called when the animation is over. */
  const resolveSlide = useRef<(() => void) | null>(null);

  // Next keeps a page she left alive but hidden (Activity) and shows it again
  // on browser back. Clear the slide out when it hides, so it comes back in
  // from the side it left by instead of staying invisible.
  useLayoutEffect(
    () => () => {
      resolveSlide.current = null;
      setLeaving(null);
    },
    [],
  );

  useEffect(() => {
    router.prefetch(nextHref);
    router.prefetch(backHref);
  }, [router, nextHref, backHref]);

  const pickedSchool = schools.find((s) => s.id === picked) ?? null;
  const working = schools.find((s) => s.enabled) ?? null;
  const notYet = working ? `Not yet. ${working.name} works today.` : "Not yet.";

  function speak(text: string) {
    setSay(text);
    setTalking(true);
  }

  function pick(index: number) {
    const school = schools[index];
    if (!school || school.id === picked) return;
    setPicked(school.id);
    speak(school.quip);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = schools.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    cards.current[next]?.focus();
    pick(next);
  }

  /** Plays the slide out; resolves when it is over (at once with no motion). */
  function slideOut(direction: Exclude<Leaving, null>): Promise<void> {
    const done = new Promise<void>((resolve) => {
      resolveSlide.current = resolve;
      // In case the animation's end is never reported (a tab in the background).
      setTimeout(resolve, mode === "instant" ? 0 : SLIDE_FALLBACK_MS);
    });
    setLeaving(direction);
    return done;
  }

  function goBack() {
    if (leaving) return;
    void slideOut("back").then(() => router.push(backHref));
  }

  function onContinue() {
    if (!pickedSchool || leaving || pending) return;
    if (!pickedSchool.enabled) {
      speak(notYet);
      return;
    }
    const id = pickedSchool.id;
    // Started outside the transition: a state update inside it would wait for the action.
    const slid = slideOut("forward");
    startTransition(async () => {
      const [result] = await Promise.all([choose(id), slid]);
      if (result.ok) {
        router.push(nextHref);
      } else {
        // Could not store it: come back so she can try again.
        setLeaving(null);
        speak("Something went wrong on our side. Try again in a minute.");
      }
    });
  }

  // The tab stop: the picked card, or the first one.
  const tabIndexOf = (id: string, index: number) =>
    picked === null ? (index === 0 ? 0 : -1) : picked === id ? 0 : -1;

  const move = mode === "full" ? SLIDE_PX : 0;
  const transition =
    mode === "instant"
      ? { duration: 0 }
      : mode === "calm"
        ? { duration: calmDuration, ease: "linear" as const }
        : { duration: duration.base, ease: ease.out };
  const target =
    leaving === "forward"
      ? { opacity: 0, x: -move }
      : leaving === "back"
        ? { opacity: 0, x: move }
        : { opacity: 1, x: 0 };

  const label = pickedSchool && !pickedSchool.enabled ? `Tell me when ${pickedSchool.name} is ready` : "Continue";

  return (
    <div className="min-h-dvh overflow-x-clip min-[700px]:bg-paper">
      <motion.div
        className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col px-[var(--pad)] pt-[max(16px,env(safe-area-inset-top,0px))] pb-[max(28px,env(safe-area-inset-bottom,0px))]"
        initial={{ opacity: 0, x: move }}
        animate={target}
        transition={transition}
        onAnimationComplete={() => {
          if (leaving) resolveSlide.current?.();
        }}
      >
        <div className="-ml-3 flex min-h-11 items-center">
          <Button variant="icon" aria-label="Back" onClick={goBack}>
            {BackIcon}
          </Button>
        </div>

        <h1 id="school-title" tabIndex={-1} className="type-h26 mt-2">
          Where do you study?
        </h1>

        <div role="radiogroup" aria-labelledby="school-title" className="mt-6 grid gap-3">
          {schools.map((school, index) => {
            const checked = picked === school.id;
            return (
              <button
                key={school.id}
                ref={(el) => {
                  cards.current[index] = el;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={tabIndexOf(school.id, index)}
                onClick={() => pick(index)}
                onKeyDown={(e) => onKeyDown(e, index)}
                className={
                  "group grid min-h-[84px] w-full grid-cols-[44px_1fr_24px] items-center gap-x-3.5 rounded-[20px] " +
                  "border-2 border-solid border-transparent p-[18px] text-left text-ink " +
                  "transition-[border-color] duration-quick ease-out aria-checked:border-ink " +
                  TONE[school.tone]
                }
              >
                <span
                  aria-hidden="true"
                  className="grid size-11 place-items-center rounded-full bg-surface font-display text-[20px] font-semibold [font-variation-settings:'SOFT'_100]"
                >
                  {school.full.charAt(0)}
                </span>
                <span>
                  <span className="block text-[17px] font-semibold">{school.full}</span>
                  <span className="mt-0.5 block text-[13px] text-ink-2">{school.where}</span>
                </span>
                <span
                  aria-hidden="true"
                  className={
                    "grid size-6 place-items-center rounded-full bg-ink text-surface " +
                    "scale-[0.6] opacity-0 group-aria-checked:scale-100 group-aria-checked:opacity-100 " +
                    "transition-[opacity,scale] [transition-duration:var(--t-quick),var(--t-base)] " +
                    "[transition-timing-function:var(--e-out),var(--e-reward)] motion-reduce:transition-opacity"
                  }
                >
                  {CheckIcon}
                </span>
              </button>
            );
          })}
          <div className="rounded-[20px] border border-dashed border-line px-[18px] py-4 text-[15px] text-ink-3">
            More schools soon
          </div>
        </div>

        <div className="flex-1" />

        <div className="mb-4 flex min-h-[92px] items-end gap-3">
          <Vitonen size={64} state={talking ? "talking" : "idle"} className="flex-none" />
          <div aria-live="polite" className="mb-[18px] flex-1">
            {say !== null && (
              <motion.div
                initial={mode === "full" ? { opacity: 0, scale: 0.85 } : { opacity: 0 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={
                  mode === "instant"
                    ? { duration: 0 }
                    : mode === "calm"
                      ? { duration: calmDuration, ease: "linear" }
                      : { scale: rewardSpring, opacity: { duration: duration.quick, ease: ease.out } }
                }
                className={
                  "relative origin-bottom-left rounded-[20px] border border-solid border-line bg-surface px-4 py-3 text-[15px] " +
                  "shadow-[var(--shadow-card)] after:absolute after:bottom-4 after:-left-[7px] after:size-3 after:rotate-[135deg] " +
                  "after:border-r after:border-b after:border-solid after:border-line after:bg-surface after:content-['']"
                }
              >
                <p>
                  <Typewriter key={say} text={say} onDone={() => setTalking(false)} />
                </p>
              </motion.div>
            )}
          </div>
        </div>

        <Button size="lg" block disabled={picked === null} onClick={onContinue}>
          {label}
        </Button>
      </motion.div>
    </div>
  );
}

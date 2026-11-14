/*
 * The sorting scene's script (M5-09). Pure: no timers, no DOM. The scene
 * component walks `steps` in order; this file only says what is said, shown
 * and waited for, copied from the prototype (main-flow.html, JS 2337-2407).
 *
 * Timing model. Every step has `ms`: the fixed time the scene waits once the
 * step's own action is done. Typing a hat line takes as long as the
 * typewriter takes, which is the component's business, so a "say" step's
 * `ms` is the hold *after* the line is typed. `totalMs` is the sum of every
 * fixed wait; the real scene runs that plus the typing time.
 *
 * `calm` is reduced motion. As in the prototype it lengthens the holds
 * (500 to 900 ms), shortens the lead-in, and drops the house flicker: the
 * house simply fades in.
 *
 * `minimumMs` is max(6000, totalMs): the scene never ends sooner. It also
 * never ends before the real sync says it is done, but this file cannot
 * know that: the caller keeps the last step (the wipe text) on screen until
 * both `minimumMs` has passed and the sync has finished, then moves on.
 *
 * The house names stay for now (see decisions); M8-19 replaces them before
 * any public release.
 */

import { SCHOOLS, type SchoolId } from "../schools";

export type SortingStep =
  /** Wait `ms` with nothing new on screen. */
  | { kind: "pause"; ms: number }
  /** The hat types `text`, then holds `ms`. */
  | { kind: "say"; text: string; ms: number }
  /** One frame of the house flicker: show `text` for `ms`. */
  | { kind: "flicker"; text: string; ms: number }
  /** The house lands on `text`: `animMs` of landing, then the whole step waits `ms` (landing included). */
  | { kind: "house"; text: string; animMs: number; ms: number }
  /** The hat stops thinking and confetti bursts; then wait `ms`. */
  | { kind: "confetti"; ms: number }
  /** The wipe covers the hat; then wait `ms`. */
  | { kind: "wipe"; ms: number }
  /** The wipe's text swaps to `text`; then wait `ms`. The caller holds here until sync is done. */
  | { kind: "wipeText"; text: string; ms: number };

export type SortingScript = {
  steps: SortingStep[];
  /** Sum of every step's fixed wait (typing and wipe animation not included). */
  totalMs: number;
  /** The scene never ends sooner than this: max(6000, totalMs). */
  minimumMs: number;
};

export type SortingInput = {
  school: SchoolId;
  /** Her programme's name, or null when we could not tell (the line is then skipped). */
  programme: string | null;
  /** Reduced motion. */
  calm: boolean;
};

export const MIN_SCENE_MS = 6000;
export const HOLD_MS = 500;
export const HOLD_CALM_MS = 900;
export const FLICKER_COUNT = 10;
export const FLICKER_MS = 120;
export const HOUSES = ["SLYTHERIN", "RAVENCLAW"] as const;
export const HOUSE_FINAL = "RAVENCLAW.";
export const LAST_LINE =
  "A bad bitch. A tad stuck up. You overworry about deadlines you always make.";
export const WIPE_TEXT = "Here's your study OS, all set up.";

export function sortingScript({ school, programme, calm }: SortingInput): SortingScript {
  const hold = calm ? HOLD_CALM_MS : HOLD_MS;
  const s = SCHOOLS[school];
  const lines = [
    `So you're ${s.article} ${s.name} baddie, huh.`,
    "Hmm. Smart.",
    "A little stuck up.",
  ];
  if (programme && programme.trim()) lines.push(`${programme.trim()}. Of course.`);

  const steps: SortingStep[] = [{ kind: "pause", ms: calm ? 200 : 900 }];
  for (const text of lines) steps.push({ kind: "say", text, ms: hold });
  steps.push({ kind: "say", text: "Let me think…", ms: 0 });

  if (calm) {
    steps.push({ kind: "house", text: HOUSE_FINAL, animMs: 150, ms: 150 + 900 });
  } else {
    for (let k = 0; k < FLICKER_COUNT; k++) {
      steps.push({ kind: "flicker", text: HOUSES[k % 2], ms: FLICKER_MS });
    }
    steps.push({ kind: "house", text: HOUSE_FINAL, animMs: 400, ms: 400 + 500 });
  }

  steps.push({ kind: "say", text: LAST_LINE, ms: calm ? 1600 : 1100 });
  steps.push({ kind: "confetti", ms: calm ? 0 : 900 });
  steps.push({ kind: "wipe", ms: 700 });
  steps.push({ kind: "wipeText", text: WIPE_TEXT, ms: 200 });

  const totalMs = steps.reduce((sum, step) => sum + step.ms, 0);
  return { steps, totalMs, minimumMs: Math.max(MIN_SCENE_MS, totalMs) };
}

/** Course-code prefix to programme name. Small on purpose; add rows as we meet them. */
export const PROGRAMMES: Record<string, string> = {
  ISM: "Information and Service Management",
};

/** Just the part of a course this file reads. */
export type CourseCode = { code: string | null | undefined };

/**
 * Her programme, guessed from the commonest course-code prefix (the leading
 * letters, so "ISM-E1001" and "ism101" both count as ISM). Null when she has
 * no codes, when two prefixes tie for commonest, or when the winner is not in
 * `PROGRAMMES`.
 */
export function guessProgramme(courses: readonly CourseCode[]): string | null {
  const counts = new Map<string, number>();
  for (const { code } of courses) {
    const prefix = code?.trim().match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
    if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  let tied = false;
  for (const [prefix, n] of counts) {
    if (n > bestCount) {
      best = prefix;
      bestCount = n;
      tied = false;
    } else if (n === bestCount) {
      tied = true;
    }
  }
  if (!best || tied) return null;
  return PROGRAMMES[best] ?? null;
}

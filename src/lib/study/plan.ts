/**
 * The plan: one pace for an exam, where keeping it lands on exam day, and
 * the status that follows from the two.
 *
 * Every screen that names a pace, a projected percent or a status (the
 * verdict chip, the Today tab, the Progress line and chart, Home, the done
 * screen) reads it from `planOf` and `verdictOf`, so they always say the
 * same pace and the same number, and none promises what the model cannot
 * produce.
 *
 * Pure: no clock, no storage. The projection is a simulation of the same
 * model as the forecast (`deckForecast`): day by day from `deck.now` to the
 * day before the exam, exactly the bites the screen asks for are built by
 * the app's own builder (`biteSections`) and played with every card recalled
 * (graded Good), and the forecast is read after each day. It is what the
 * plan gives when she keeps it and remembers; not a promise about her memory.
 * Because the projection is the plan played forward, a day on which she does
 * what the screen asked leaves the projected end where it was.
 *
 * The pace:
 * - A paced exam (core marks, `./pace`): the core-first plan. What it asks of
 *   a day (`askedToday`): while new cards are open, the bites that use up the
 *   day's budget of new cards (each bite also brings up to four reviews);
 *   past the cut-off, the bites that clear the reviews due that day.
 * - Any other deck: the fewest bites a day that reach her target, from one up
 *   to what the app serves in a day (`BITES_PER_DAY`: two for an exam, one
 *   for a quiz). When even that falls short, that most is the pace and the
 *   target is not reachable.
 *
 * The status (`verdictOf`), four honest states and "ready":
 * - before start: the study start is still ahead. "Starts Tue 24 Nov".
 * - ready: today's forecast already meets the target.
 * - on track: the usual pace reaches the target (a bite a day; for a paced
 *   exam, its core-first plan).
 * - reachable: it takes more than a bite a day, and that reaches it. "Two
 *   bites a day gets you to your 85% by Mon 23 Nov".
 * - not reachable: the most the plan gives ends below the target. "At this
 *   point you won’t reach 85% by Mon 23 Nov. Two bites a day gets you to
 *   about 23%." (a paced exam adds "Core cards first.")
 *
 * Choices:
 * - A day of the simulation is played at the clock time of `deck.now`, 20
 *   seconds a card. Today counts from what is already done: the bites done
 *   today (unpaced) or the new cards met today (paced).
 * - "Reaches" compares the projected percent as shown (`endShown`, the one
 *   rounded number the sentence, the chip and the chart's end label all use)
 *   with the target.
 * - Cost, measured on a 400-card deck a week out: about 60 bites, well under
 *   0.1 s once warm. `dueNow` (one recall prediction a card) keeps it there.
 */
import { daysBetween } from "../dates";
import { BITES_PER_DAY, biteSections, type Deck } from "./bite";
import { deckForecast, VERDICTS, type Verdict } from "./forecast";
import { grade, newCard, type MemoryState } from "./memory";
import { impossibleLine, isPaced, NEW_PER_BITE, onTrackLine, paceOf, type Pace } from "./pace";

export type PlanPace =
  /** So many bites every day. */
  | { kind: "bites"; perDay: number }
  /**
   * The core-first plan. `open`: new cards are still served (false past the cut-off).
   * `perDay`: the bites a day of the plan holds (today's budget of new cards, five a bite).
   * `bitesToday`: what the plan still asks of today.
   */
  | { kind: "core"; open: boolean; perDay: number; bitesToday: number };

export type Plan = {
  pace: PlanPace;
  /** The forecast with this pace: today (index 0) to exam day (the last), 0..100, not rounded. */
  curve: number[];
  /** Where the pace lands on exam day: the last point of `curve`. */
  end: number;
  /** `end` as every screen shows it: one rounded number for the sentence, the chip and the chart. */
  endShown: number;
  /** `endShown` meets the target. */
  reaches: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Time one simulated card takes. */
const CARD_MS = 20_000;
/** No simulated day plays more bites than this (a paced day ends when nothing is left). */
const MAX_BITES_A_DAY = 40;

const ms = (t: number | Date) => (typeof t === "number" ? t : t.getTime());

type States = Record<string, MemoryState>;

/** Plays one bite at `t`, every card recalled; returns the time after it, or null when there is no bite. */
function playBite(deck: Deck, states: States, newToday: string[], t: number): number | null {
  const sections = biteSections({ ...deck, states, now: t, newToday, kind: deck.kind ?? "exam", bitesDoneToday: 0 });
  if (!sections) return null;
  for (const [, ids] of sections) {
    for (const id of ids) {
      t += CARD_MS;
      const at = new Date(t);
      if ((states[id]?.lastReviewAt ?? null) === null) newToday.push(id);
      states[id] = grade(states[id] ?? newCard(at), 3, at);
    }
  }
  return t;
}

/**
 * The bites a paced exam's plan still asks of today (0 for a deck that is not
 * paced): while new cards are open, the bites that use up today's budget;
 * past the cut-off, the bites that clear what is due now.
 */
export function askedToday(deck: Deck): number {
  const pace = paceOf(deck);
  if (!pace) return 0;
  if (pace.open) return pace.bites;
  const states: States = { ...deck.states };
  let t = ms(deck.now);
  let bites = 0;
  while (bites < MAX_BITES_A_DAY) {
    const next = playBite(deck, states, [], t);
    if (next === null) break;
    t = next;
    bites++;
  }
  return bites;
}

/**
 * The forecast day by day when she does `perDay` bites a day (or, with
 * `"core"`, what a paced deck's plan asks each day: `askedToday`), each card
 * recalled. One value per day from today (the forecast now) to exam day.
 * `doneToday` bites are already behind her today.
 */
export function simulate(deck: Deck, perDay: number | "core", doneToday = 0): number[] {
  const start = ms(deck.now);
  const exam = ms(deck.examAt);
  const days = Math.max(0, daysBetween(new Date(start), new Date(exam)));
  const states: States = { ...deck.states };
  const curve = [deckForecast(deck, states)];
  for (let d = 0; d < days; d++) {
    let t = start + d * DAY_MS;
    const newToday = d === 0 ? [...(deck.newToday ?? [])] : [];
    const bites =
      perDay === "core" ? askedToday({ ...deck, states, now: t, newToday }) : perDay - (d === 0 ? doneToday : 0);
    for (let b = 0; b < bites && t < exam; b++) {
      const next = playBite(deck, states, newToday, t);
      if (next === null) break;
      t = next;
    }
    curve.push(deckForecast(deck, states));
  }
  return curve;
}

/** Today's pace of a paced deck. */
function corePace(deck: Deck): PlanPace {
  const pace = paceOf(deck)!;
  const bitesToday = askedToday(deck);
  return { kind: "core", open: pace.open, perDay: pace.open ? Math.ceil(pace.budget / NEW_PER_BITE) : bitesToday, bitesToday };
}

const made = (pace: PlanPace, curve: number[], target: number): Plan => {
  const end = curve[curve.length - 1];
  const endShown = Math.round(end);
  return { pace, curve, end, endShown, reaches: endShown >= target };
};

/** A plan that goes nowhere: for an exam that is over or has not started, where no pace is promised. */
export function flatPlan(deck: Deck, target: number): Plan {
  const pace: PlanPace = isPaced(deck) ? { kind: "core", open: false, perDay: 0, bitesToday: 0 } : { kind: "bites", perDay: 1 };
  return made(pace, [deckForecast(deck)], target);
}

/** The exam's one pace and where it lands (see the header). `doneToday`: bites done today. */
export function planOf(deck: Deck, target: number, doneToday = 0): Plan {
  if (isPaced(deck)) return made(corePace(deck), simulate(deck, "core"), target);
  const most = BITES_PER_DAY[deck.kind ?? "exam"];
  let best = made({ kind: "bites", perDay: 1 }, simulate(deck, 1, doneToday), target);
  for (let perDay = 2; perDay <= most && !best.reaches; perDay++) {
    best = made({ kind: "bites", perDay }, simulate(deck, perDay, doneToday), target);
  }
  return best;
}

const NUMBER_WORDS = ["no", "a", "two", "three", "four", "five", "six"];

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const bitesWord = (n: number) => `${n} bite${n === 1 ? "" : "s"}`;

/**
 * The pace in words, inside a sentence: "a bite a day", "two bites a day";
 * for a paced exam "8 bites a day", and past its cut-off "your reviews".
 */
export function paceWords(pace: PlanPace): string {
  if (pace.kind === "core") return pace.open ? `${bitesWord(pace.perDay)} a day` : "your reviews";
  const n = pace.perDay;
  return `${NUMBER_WORDS[n] ?? n} bite${n === 1 ? "" : "s"} a day`;
}

/** "gets" after one pace, "get" after "your reviews". */
const getsWord = (pace: PlanPace) => (pace.kind === "core" && !pace.open ? "get" : "gets");

export type VerdictOptions = {
  /** Exam day as a sentence names it (`byDay`): "Monday", "Mon 23 Nov". */
  day: string;
  /** Before the study start: the day it opens, "Tue 24 Nov". */
  starts?: string | null;
};

/** The status, from the plan's own pace and number (the states are in the header). */
export function verdictOf(forecastShown: number, target: number, plan: Plan, options: VerdictOptions): Verdict {
  const { day, starts } = options;
  if (starts) return { key: "before_start", text: `Starts ${starts}`, ok: false };
  if (forecastShown >= target) return VERDICTS.ready;
  const { pace } = plan;
  if (!plan.reaches) {
    const core = pace.kind === "core" && pace.open ? " Core cards first." : "";
    return {
      key: "not_reachable",
      text:
        `At this point you won\u2019t reach ${target}% by ${day}. ` +
        `${capital(paceWords(pace))} ${getsWord(pace)} you to about ${plan.endShown}%.${core}`,
      ok: false,
    };
  }
  if (pace.kind === "core") {
    const text = pace.open
      ? `On track with ${paceWords(pace)}`
      : pace.bitesToday > 0
        ? `On track with ${bitesWord(pace.bitesToday)} of reviews today`
        : "On track. Today\u2019s plan is done.";
    return { key: "on_track", text, ok: true };
  }
  if (pace.perDay === 1) return VERDICTS.on_track;
  return { key: "reachable", text: `${capital(paceWords(pace))} gets you to your ${target}% by ${day}`, ok: false };
}

/**
 * The Progress tab's sentence, with the same pace and number as the status:
 * "A bite a day gets you to about 47% by Mon 23 Nov." For a paced exam:
 * "8 bites a day gets you to about 91% by Monday.", and past its cut-off
 * "Your reviews get you to about 91% by Monday."
 */
export function planSentence(plan: Plan, day: string): string {
  return `${capital(paceWords(plan.pace))} ${getsWord(plan.pace)} you to about ${plan.endShown}% by ${day}.`;
}

/** The done screen's lead-in, before "and you land around 62% on Monday": "Keep a bite a day", "Keep 8 bites a day". */
export function keepWords(pace: PlanPace): string {
  return pace.kind === "core" && !pace.open ? "Keep up your reviews" : `Keep ${paceWords(pace)}`;
}

/**
 * A paced exam's line for today, without its full stop, or null when today
 * has no new cards left:
 * - the plan reaches her target: "3 bites today keeps you on track for Monday";
 * - it does not: "3 bites today. The plan gets you to about 62% by Monday";
 * - the days cannot hold the core cards: with `sayImpossible` (the exam page,
 *   the one place that says it) "There are more cards than days: core cards
 *   first, about 60 a day"; elsewhere the second form.
 */
export function todayLine(
  pace: Pick<Pace, "open" | "bites" | "budget" | "impossible">,
  plan: Plan,
  day: string,
  options: { more?: boolean; sayImpossible?: boolean } = {},
): string | null {
  if (!pace.open || pace.bites === 0) return null;
  if (pace.impossible && options.sayImpossible) return impossibleLine(pace);
  if (plan.reaches && !pace.impossible) return onTrackLine(pace, day, options.more);
  return `${bitesWord(pace.bites)} today. The plan gets you to about ${plan.endShown}% by ${day}`;
}

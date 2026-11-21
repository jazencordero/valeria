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
 * the app's own builder (`biteSections`) and played, and the forecast is
 * read after each day.
 *
 * What the projection expects. A planned review is not counted as surely
 * recalled. For a card she has met, the model's own predicted recall at the
 * moment of the review is the chance she gets it; with the rest she misses
 * it, passes it on the retry a minute later, and carries the weaker memory a
 * miss leaves (`doubt`). A card that may have been missed is reviewed again
 * on the next day of the plan in that case (`repair`). The projected forecast
 * is the expected value over the two cases (`expectedForecast`); which cards
 * a day serves follows the recalled case. A card she has never met is learned
 * (there is nothing to recall yet).
 * So the projection is what the plan gives at the recall the model expects of
 * her, not at perfect recall. A session in which she recalls every card
 * leaves the projected end where it was or higher; a miss lowers it only by
 * what that miss costs beyond what was already expected.
 * Before this every planned review counted as recalled: on a real deck two
 * days before the exam each missed card took about 0.08 points off the
 * projected end, so a day of reviews with one answer in five wrong lowered it
 * by about two points and could turn "on track" into "not reachable" while
 * she did exactly what was asked.
 *
 * The pace:
 * - A paced exam (core marks, `./pace`): the core-first plan. What it asks of
 *   a day (`askedToday`): while new cards are open, the bites that use up the
 *   day's budget of new cards (each bite also brings up to four reviews);
 *   past the cut-off, the bites that clear that day's important reviews
 *   (the due cards by what each is worth, until the rest is together worth
 *   less than one forecast point: `reviewDay` in `./bite`). The projection
 *   plays exactly that, so it is what she gets if she stops at "enough".
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
 * Today as time (`todayLine`, `todayPlan`): when a paced exam's plan still
 * asks for more than three bites today (`TIME_FROM_BITES`), the line says the
 * minutes instead, "About 25 minutes today keeps you on track for Mon 23 Nov
 * (7 bites)", and the screens offer the rest in one go (`buildLong` in
 * `./bite`). The minutes are the cards left in today's plan
 * (`cardsLeftToday`) at her own pace when it is known (`minutesFor`): a
 * number fixed by how the day started, so it only goes down as she answers
 * cards. The bite count in brackets may be cut differently as she goes; the
 * minutes never rise. Three bites or fewer keep the bite wording. One-go
 * sessions count toward the pace card by card, like bites: `simulate` with
 * `"long"` plays the plan that way and lands where the bites do.
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
import { daysBetween, onDay, startOfDay, TODAY } from "../dates";
import {
  BITES_PER_DAY,
  biteSections,
  endOfDay,
  longSections,
  reviewDay,
  WARM_MAX,
  type BiteInput,
  type Deck,
  type Section,
} from "./bite";
import { dueNow } from "./exam-aim";
import { deckForecast, expectedForecast, VERDICTS, type Doubt, type Verdict } from "./forecast";
import { grade, newCard, recallAt, type MemoryState } from "./memory";
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

/** More bites than this left today: the line says minutes, and the rest is offered in one go. */
export const TIME_FROM_BITES = 3;

type Played = { t: number; cards: number };

type Doubts = Map<string, Doubt>;
/** A missed card comes back in its session and is passed then: this long after the miss. */
const RETRY_MS = 60_000;

/** The card's memory when she misses it at `at` and passes it on the retry. */
const missed = (state: MemoryState, at: Date) => grade(grade(state, 1, at), 3, new Date(at.getTime() + RETRY_MS));

/**
 * Books the chance that a planned review of a card she has met is missed (see
 * "What the projection expects" in the header). `state` is the card's memory
 * going into the review at `at`.
 */
function doubt(doubts: Doubts, id: string, state: MemoryState, at: Date): void {
  const had = doubts.get(id);
  const was = had?.p ?? 0;
  // Missed now, having recalled it every time so far.
  const fresh = (1 - was) * (1 - recallAt(state, at));
  // One memory stands for the missed case: the likelier of "missed now" and "missed earlier, reviewed again now".
  const stands = !had || fresh >= was ? missed(state, at) : grade(had.state, 3, at);
  doubts.set(id, { p: was + fresh, state: stands });
}

/**
 * The end of a projected day: a card she may have missed earlier and that the
 * plan did not review today is reviewed in that case (a missed card is the
 * most valuable one to see again), if it is due by tonight.
 */
function repair(deck: Deck, doubts: Doubts, played: ReadonlySet<string>, t: number): void {
  const exam = ms(deck.examAt);
  if (t >= exam) return;
  const by = Math.min(endOfDay(t), exam);
  const at = new Date(t);
  for (const [id, d] of doubts) {
    if (played.has(id) || dueNow(d.state, deck.examAt, by) === null) continue;
    doubts.set(id, { p: d.p, state: grade(d.state, 3, at) });
  }
}

/**
 * Plays one session at `t` (a bite, or with `longSections` a one-go session), every card
 * recalled; returns the time after it and its cards, or null when there is none.
 */
function play(
  deck: Deck,
  states: States,
  newToday: string[],
  t: number,
  build: (input: BiteInput) => Section[] | null = biteSections,
  doubts?: Doubts,
  played?: Set<string>,
): Played | null {
  const sections = build({ ...deck, states, now: t, newToday, kind: deck.kind ?? "exam", bitesDoneToday: 0 });
  if (!sections) return null;
  let cards = 0;
  for (const [, ids] of sections) {
    for (const id of ids) {
      t += CARD_MS;
      cards++;
      const at = new Date(t);
      const before = states[id];
      if ((before?.lastReviewAt ?? null) === null) newToday.push(id);
      else if (doubts) doubt(doubts, id, before, at);
      played?.add(id);
      states[id] = grade(before ?? newCard(at), 3, at);
    }
  }
  return { t, cards };
}

/**
 * The cards left in today's plan of a paced exam: the number the minutes are
 * made from. It is fixed by how the day started and only goes down as she
 * answers cards, whatever the clock says and however the bites are cut:
 * - While new cards are open: the new cards today's budget still holds
 *   (`pace.left`), plus the reviews still allowed for. The day's allowance of
 *   reviews is four a bite (`WARM_MAX`) for the bites the day's whole budget
 *   makes, and never more than the cards she had graded before today that are
 *   due by tonight; each such card she reviews today uses one. A card she
 *   first met today coming back the same day is not counted: it is practice
 *   on top, not part of the plan's cards. Once the budget is used the plan
 *   asks for nothing more: 0.
 * - On a reviews-only day: the important reviews still waiting (`reviewDay`);
 *   the optional ones are not asked for and not counted.
 */
export function cardsLeftToday(deck: Deck): number {
  const pace = paceOf(deck);
  if (!pace) return 0;
  if (!pace.open) return reviewDay(deck)?.today ?? 0;
  if (pace.left === 0) return 0;
  const start = startOfDay(new Date(ms(deck.now))).getTime();
  const by = Math.min(endOfDay(deck.now), ms(deck.examAt));
  const metToday = new Set(deck.newToday ?? []);
  let reviewed = 0;
  let waiting = 0;
  for (const c of deck.cards) {
    const state = deck.states[c.id];
    if (!c.active || !state || state.lastReviewAt === null || metToday.has(c.id)) continue;
    if (state.lastReviewAt >= start) reviewed++;
    else if (dueNow(state, deck.examAt, by) !== null) waiting++;
  }
  const allowance = Math.min(WARM_MAX * Math.ceil(pace.budget / NEW_PER_BITE), waiting + reviewed);
  return pace.left + Math.max(0, allowance - reviewed);
}

/**
 * What a paced exam's plan still asks of today: its bites, and the cards
 * left in it (`cardsLeftToday`; 0 and 0 for a deck that is not paced, or when
 * today's plan is done). The bites of a reviews-only day are counted by
 * playing them forward, like the projection.
 */
export function todayPlan(deck: Deck): { bites: number; cards: number } {
  const pace = paceOf(deck);
  if (!pace) return { bites: 0, cards: 0 };
  const cards = cardsLeftToday(deck);
  if (pace.open) return { bites: pace.bites, cards };
  const states: States = { ...deck.states };
  const newToday = [...(deck.newToday ?? [])];
  let t = ms(deck.now);
  let bites = 0;
  while (bites < MAX_BITES_A_DAY) {
    // A reviews-only day asks for the important reviews, not for every due card.
    if ((reviewDay({ ...deck, states, now: t, newToday })?.today ?? 0) === 0) break;
    const next = play(deck, states, newToday, t);
    if (!next) break;
    t = next.t;
    bites++;
  }
  return { bites, cards };
}

/**
 * The bites a paced exam's plan still asks of today (0 for a deck that is not
 * paced): while new cards are open, the bites that use up today's budget;
 * past the cut-off, the bites that clear today's important reviews.
 */
export function askedToday(deck: Deck): number {
  const pace = paceOf(deck);
  if (!pace) return 0;
  if (pace.open) return pace.bites;
  return todayPlan(deck).bites;
}

/**
 * The forecast day by day when she does `perDay` bites a day (or, with
 * `"core"`, what a paced deck's plan asks each day: `askedToday`), each card
 * recalled. One value per day from today (the forecast now) to exam day.
 * `doneToday` bites are already behind her today. With `"long"` the same
 * paced plan is done in one-go sessions instead of bites.
 */
export function simulate(deck: Deck, perDay: number | "core" | "long", doneToday = 0): number[] {
  const start = ms(deck.now);
  const exam = ms(deck.examAt);
  const days = Math.max(0, daysBetween(new Date(start), new Date(exam)));
  const states: States = { ...deck.states };
  const doubts: Doubts = new Map();
  const curve = [deckForecast(deck, states)];
  for (let d = 0; d < days; d++) {
    let t = start + d * DAY_MS;
    const newToday = d === 0 ? [...(deck.newToday ?? [])] : [];
    const played = new Set<string>();
    if (perDay === "long") {
      // The same plan done in one-go sessions: one after the other while today still asks for a bite.
      for (let s = 0; s < MAX_BITES_A_DAY && t < exam; s++) {
        if (askedToday({ ...deck, states, now: t, newToday }) === 0) break;
        const next = play(deck, states, newToday, t, longSections, doubts, played);
        if (!next) break;
        t = next.t;
      }
    } else {
      const bites =
        perDay === "core" ? askedToday({ ...deck, states, now: t, newToday }) : perDay - (d === 0 ? doneToday : 0);
      for (let b = 0; b < bites && t < exam; b++) {
        const next = play(deck, states, newToday, t, biteSections, doubts, played);
        if (!next) break;
        t = next.t;
      }
    }
    repair(deck, doubts, played, t);
    curve.push(expectedForecast(deck, states, doubts));
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
        `At this point you won\u2019t reach ${target}% ${onDay("by", day)}. ` +
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
  return { key: "reachable", text: `${capital(paceWords(pace))} gets you to your ${target}% ${onDay("by", day)}`, ok: false };
}

/**
 * The Progress tab's sentence, with the same pace and number as the status:
 * "A bite a day gets you to about 47% by Mon 23 Nov." For a paced exam:
 * "8 bites a day gets you to about 91% by Monday.", and past its cut-off
 * "Your reviews get you to about 91% by Monday."
 */
export function planSentence(plan: Plan, day: string): string {
  return `${capital(paceWords(plan.pace))} ${getsWord(plan.pace)} you to about ${plan.endShown}% ${onDay("by", day)}.`;
}

/** The done screen's lead-in, before "and you land around 62% on Monday": "Keep a bite a day", "Keep 8 bites a day". */
export function keepWords(pace: PlanPace): string {
  return pace.kind === "core" && !pace.open ? "Keep up your reviews" : `Keep ${paceWords(pace)}`;
}

/** More than three bites are left today: the plan is said as time and offered in one go. */
export function saidAsTime(bites: number): boolean {
  return bites > TIME_FROM_BITES;
}

const minutesWord = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

/**
 * A paced exam's line for today, without its full stop, or null when today
 * has no new cards left:
 * - the plan reaches her target: "3 bites today keeps you on track for Monday";
 * - it does not: "3 bites today. The plan gets you to about 62% by Monday";
 * - the days cannot hold the core cards: with `sayImpossible` (the exam page,
 *   the one place that says it) "There are more cards than days: core cards
 *   first, about 60 a day"; elsewhere the second form.
 *
 * With `minutes` (what today's remaining plan takes) and more than three bites
 * left, the same two lines say the time and keep the count in brackets:
 * "About 25 minutes today keeps you on track for Mon 23 Nov (7 bites)" and
 * "About 25 minutes today (7 bites). The plan gets you to about 62% by
 * Monday". That form is also said on a reviews-only day, as "About 25 minutes
 * of reviews today ..." (`pace.bites` is then the review bites the day asks
 * for); with three bites or fewer such a day has no line, as before.
 */
export function todayLine(
  pace: Pick<Pace, "open" | "bites" | "budget" | "impossible">,
  plan: Plan,
  day: string,
  options: { more?: boolean; sayImpossible?: boolean; minutes?: number | null } = {},
): string | null {
  if (pace.bites === 0) return null;
  const time = options.minutes != null && saidAsTime(pace.bites) ? options.minutes : null;
  if (!pace.open && time === null) return null;
  if (pace.open && pace.impossible && options.sayImpossible) return impossibleLine(pace);
  const reaches = plan.reaches && !(pace.open && pace.impossible);
  if (time === null) {
    if (reaches) return onTrackLine(pace, day, options.more);
    return `${bitesWord(pace.bites)} today. The plan gets you to about ${plan.endShown}% ${onDay("by", day)}`;
  }
  const what = pace.open ? "" : " of reviews";
  const about = `About ${options.more ? `${time} more minute${time === 1 ? "" : "s"}` : minutesWord(time)}${what} today`;
  if (reaches) return `${about} keeps you on track${day === TODAY ? "" : ` for ${day}`} (${bitesWord(pace.bites)})`;
  return `${about} (${bitesWord(pace.bites)}). The plan gets you to about ${plan.endShown}% ${onDay("by", day)}`;
}

/** The done screen's line after a session when today's plan is not finished: "About 12 minutes of today's plan left". */
export function leftLine(minutes: number): string | null {
  return minutes > 0 ? `About ${minutesWord(minutes)} of today\u2019s plan left` : null;
}

/**
 * A reviews-only day once the important reviews are done, without its full
 * stop: "The important ones are done. 43 more are optional (about +0.6%)".
 * The gain is what the optional reviews are worth together, in forecast
 * points; it is left out when it rounds to nothing. It says nothing about
 * being on track: that is the status's sentence.
 */
export function optionalLine(cards: number, gain: number): string | null {
  if (cards <= 0) return null;
  const worth = gain >= 0.05 ? ` (about +${gain.toFixed(1)}%)` : "";
  return `The important ones are done. ${cards} more ${cards === 1 ? "is" : "are"} optional${worth}`;
}

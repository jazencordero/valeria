/**
 * Card memory: the only module that talks to `ts-fsrs`.
 *
 * Everything here is pure: pass `now` in, get a new plain-JSON state out.
 * The state is what goes in the `card_states.fsrs` column, so it holds only
 * numbers and strings (times are epoch milliseconds) and survives
 * `JSON.parse(JSON.stringify(state))` unchanged.
 *
 * Scheduler choices (ts-fsrs v6):
 * - FSRS-7 with its preset weights (the library default). No per-user training.
 * - Learning steps 1 min and 10 min for new cards; a failed review card
 *   relearns with one 1 min step, so a miss is always due in 1 minute
 *   (prototype main-flow.html, LEARN_STEPS).
 * - `allowModelOverride: false`: FSRS-7 would otherwise let its own longer
 *   interval jump over the learning steps (Good on a new card would be days,
 *   not 10 minutes).
 * - `enableFuzz: false`: intervals are exact, so the button labels and the
 *   tests are deterministic. With fuzz off the card id that seeds fuzzing is
 *   unused, so it is not stored.
 * - Built with `defineScheduler` and the same middleware list as
 *   `DefaultScheduler()`, because `DefaultScheduler()` is async and this
 *   module must stay synchronous.
 */
import {
  dateChrono,
  defineScheduler,
  schedulerDesiredRetentionMiddleware,
  schedulerFuzzingMiddleware,
  schedulerLearningStepsMiddleware,
  schedulerMaximumIntervalMiddleware,
  schedulerMonotonicIntervalMiddleware,
  schedulerScheduledDaysMiddleware,
  schedulerStatsMiddleware,
} from "ts-fsrs";
import { FSRS7_DEFAULT_WEIGHTS, FSRS7Model } from "ts-fsrs/models/fsrs-7";

/** 1 Again, 2 Hard, 3 Good, 4 Easy. */
export type Grade = 1 | 2 | 3 | 4;

export const GRADES: readonly Grade[] = [1, 2, 3, 4];

/** Plain-JSON card memory, stored in `card_states.fsrs`. Times are epoch ms. */
export type MemoryState = {
  /** When the card is next due (epoch ms). */
  dueAt: number;
  /** Last time it was graded (epoch ms), or null if never. */
  lastReviewAt: number | null;
  stability: number;
  stabilityFast: number;
  difficulty: number;
  /** 0 New, 1 Learning, 2 Review, 3 Relearning. */
  state: 0 | 1 | 2 | 3;
  scheduleStatus: "new" | "learning" | "review";
  /** Index into the current (re)learning steps. */
  learningStep: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
};

/** Next interval in ms for each grade, for the answer buttons. */
export type IntervalPreview = Record<Grade, number>;

const LEARNING_STEPS = ["1m", "10m"] as const;
const RELEARNING_STEPS = ["1m"] as const;
const MINUTE = 60 * 1000;
const UNUSED_CARD_ID = 0;

const scheduler = defineScheduler({ model: FSRS7Model, chrono: dateChrono })
  .use(
    schedulerDesiredRetentionMiddleware,
    schedulerFuzzingMiddleware,
    schedulerStatsMiddleware,
    schedulerScheduledDaysMiddleware,
    schedulerLearningStepsMiddleware,
    schedulerMaximumIntervalMiddleware,
    schedulerMonotonicIntervalMiddleware,
  )
  .create({
    config: {
      fractionalDays: true,
      weights: FSRS7_DEFAULT_WEIGHTS,
      enableShortTerm: true,
      desiredRetention: 0.9,
      learningSteps: [...LEARNING_STEPS],
      relearningSteps: [...RELEARNING_STEPS],
      allowModelOverride: false,
      enableFuzz: false,
      maximumInterval: 36_500,
    },
  });

type FsrsCard = ReturnType<typeof scheduler.newCard>;

function fromCard(card: FsrsCard): MemoryState {
  return {
    dueAt: card.dueAt.getTime(),
    lastReviewAt: card.lastReviewAt ? card.lastReviewAt.getTime() : null,
    stability: card.stability,
    stabilityFast: card.stabilityFast,
    difficulty: card.difficulty,
    state: card.state as MemoryState["state"],
    scheduleStatus: card.scheduleStatus,
    learningStep: card.learningStep,
    scheduledDays: card.scheduledDays,
    reps: card.reps,
    lapses: card.lapses,
  };
}

function toCard(s: MemoryState): FsrsCard {
  return {
    ...s,
    dueAt: new Date(s.dueAt),
    lastReviewAt: s.lastReviewAt === null ? null : new Date(s.lastReviewAt),
    cardId: UNUSED_CARD_ID,
  } as FsrsCard;
}

/** A card she has never seen, due now. */
export function newCard(now: Date): MemoryState {
  return fromCard(scheduler.newCard({ now, cardId: UNUSED_CARD_ID }));
}

/** Grade a card; returns the next state (with its new `dueAt`). */
export function grade(state: MemoryState, g: Grade, now: Date): MemoryState {
  return fromCard(scheduler.review({ card: toCard(state), grade: g, now }).card);
}

/** Predicted chance (0..1) she recalls the card at `when`. 0 for a card never graded. */
export function recallAt(state: MemoryState, when: Date): number {
  if (state.lastReviewAt === null || state.state === 0) return 0;
  const elapsedDays = Math.max(
    0,
    scheduler.chrono.difference(new Date(state.lastReviewAt), when),
  );
  const r = scheduler.model.forgettingCurve(toCard(state), elapsedDays);
  return Math.min(1, Math.max(0, r));
}

/** The next interval (ms) each grade would give, for the button labels. */
export function preview(state: MemoryState, now: Date): IntervalPreview {
  const out = { 1: 0, 2: 0, 3: 0, 4: 0 } as IntervalPreview;
  for (const item of scheduler.preview({ card: toCard(state), now })) {
    out[item.grade as Grade] = item.card.dueAt.getTime() - now.getTime();
  }
  return out;
}

/** Short label for an interval: `<1 min`, `N min`, `N h`, `N d`, `N mo` (prototype ivlLabel). */
export function intervalLabel(ms: number): string {
  const mins = ms / MINUTE;
  if (mins < 1.5) return "<1 min";
  if (mins < 60) return Math.round(mins) + " min";
  if (mins < 1440) return Math.round(mins / 60) + " h";
  const d = Math.round(mins / 1440);
  return d < 30 ? d + " d" : Math.round(d / 30) + " mo";
}

/** Self-marked cards: right is Good, wrong is Again. */
export function passFail(correct: boolean): Grade {
  return correct ? 3 : 1;
}

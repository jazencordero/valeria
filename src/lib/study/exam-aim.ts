/**
 * Exam-aware scheduling: aim card reviews at recall on exam day, not forever
 * (context/study-loop.md, "Scheduler: exam-aware").
 *
 * Pure functions on top of `memory.ts` (the only module that talks to
 * ts-fsrs). Times are epoch ms, like `MemoryState`; every `now` / `examAt`
 * also accepts a `Date`.
 *
 * Choices:
 * - Wanted recall `wantedRecall(daysLeft)`: 0.85 when 14 or more days are
 *   left, 0.95 in the final 3 days, a straight line in between
 *   (0.95 - 0.10 * (daysLeft - 3) / 11). Days are fractional.
 * - `aimedDue` only ever pulls a due date earlier, never later. It finds the
 *   first moment predicted recall (`recallAt`) falls to the wanted recall at
 *   that moment. Recall falls with time and wanted recall rises toward the
 *   exam, so their difference only falls: a bisection over time finds the
 *   crossing in about 30 steps (to the minute).
 * - Clamp: a due date after the exam moves to `examAt - FINAL_MARGIN` (12 h
 *   before, the evening before a morning exam), which sits inside the final
 *   72 h window. If that moment has already passed, the card is not scheduled
 *   again (null). From the exam on, nothing is scheduled (null): the Cut says
 *   cards simply stop.
 * - `finalPass`: per concept, if no card is due in the final 72 h window, one
 *   card is moved to the start of that window (or now, if the window has
 *   begun). The card picked is the one with the lowest predicted recall on
 *   exam day, preferring cards that would not otherwise be seen before the
 *   exam (no due date, or due after it), so moving it only adds a review.
 *   Ties go to the smaller id.
 * - `spreadBacklog`: today's share is exactly
 *   `min(perDay, ceil(n / daysLeft))`, with `daysLeft = max(1, ceil(time to
 *   exam in days))`. Cards are ordered weakest concept first (lowest mean
 *   recall now over that concept's due cards), then weakest card, then id.
 * - Leech: 4 or more lapses.
 */
import { recallAt, type MemoryState } from "./memory";

export type Time = number | Date;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The final window in which every concept gets a review. */
export const FINAL_WINDOW_MS = 72 * HOUR;
/** A due date past the exam is clamped to this long before it. */
export const FINAL_MARGIN_MS = 12 * HOUR;
/** Wanted recall far from the exam (14+ days) and in the final 3 days. */
export const RECALL_FAR = 0.85;
export const RECALL_NEAR = 0.95;
export const FAR_DAYS = 14;
export const NEAR_DAYS = 3;
/** Lapses at which a card is a leech. */
export const LEECH_LAPSES = 4;

const ms = (t: Time): number => (typeof t === "number" ? t : t.getTime());

/** Wanted recall with `daysLeft` (fractional) days to the exam. */
export function wantedRecall(daysLeft: number): number {
  if (daysLeft >= FAR_DAYS) return RECALL_FAR;
  if (daysLeft <= NEAR_DAYS) return RECALL_NEAR;
  const t = (daysLeft - NEAR_DAYS) / (FAR_DAYS - NEAR_DAYS);
  return RECALL_NEAR - t * (RECALL_NEAR - RECALL_FAR);
}

/**
 * When the card should next be due, aimed at the exam (epoch ms), or null
 * when it is no longer scheduled (the exam has started, or a review past
 * the exam cannot be pulled to before it in time).
 */
export function aimedDue(
  state: MemoryState,
  examAt: Time,
  now: Time,
): number | null {
  const exam = ms(examAt);
  const t0 = ms(now);
  if (t0 >= exam) return null;

  let due = state.dueAt;

  // Pull earlier to the moment recall falls to the wanted recall.
  const graded = state.lastReviewAt !== null && state.state !== 0;
  if (graded && due > t0) {
    const gap = (t: number) =>
      recallAt(state, new Date(t)) - wantedRecall((exam - t) / DAY);
    let lo = t0;
    let hi = Math.min(due, exam);
    if (gap(lo) <= 0) {
      due = t0;
    } else if (gap(hi) <= 0) {
      for (let i = 0; i < 60 && hi - lo > MINUTE; i++) {
        const mid = lo + (hi - lo) / 2;
        if (gap(mid) <= 0) hi = mid;
        else lo = mid;
      }
      due = Math.min(due, Math.round(hi));
    }
  }

  if (due <= exam) return due;
  const clamped = exam - FINAL_MARGIN_MS;
  return clamped > t0 ? clamped : null;
}

/** A card as the final pass sees it: `dueAt` is its planned due (or null). */
export type PlannedCard = {
  id: string;
  conceptId: string;
  state: MemoryState;
  dueAt: number | null;
};

export type DueChange = { id: string; dueAt: number };

/**
 * Cards to move so every concept has one card due in the final 72 hours.
 * Returns one change per concept that lacked one, in first-seen concept order.
 */
export function finalPass(
  cards: readonly PlannedCard[],
  examAt: Time,
  now: Time,
): DueChange[] {
  const exam = ms(examAt);
  const t0 = ms(now);
  if (t0 >= exam) return [];
  const windowStart = Math.max(t0, exam - FINAL_WINDOW_MS);

  const byConcept = new Map<string, PlannedCard[]>();
  for (const c of cards) {
    const list = byConcept.get(c.conceptId);
    if (list) list.push(c);
    else byConcept.set(c.conceptId, [c]);
  }

  const examDate = new Date(exam);
  const changes: DueChange[] = [];
  for (const list of byConcept.values()) {
    const covered = list.some(
      (c) => c.dueAt !== null && c.dueAt >= windowStart && c.dueAt <= exam,
    );
    if (covered) continue;
    const unseen = list.filter((c) => c.dueAt === null || c.dueAt > exam);
    const pool = unseen.length > 0 ? unseen : list;
    const pick = pool
      .map((c) => ({ c, r: recallAt(c.state, examDate) }))
      .sort((a, b) => a.r - b.r || compareIds(a.c.id, b.c.id))[0].c;
    changes.push({ id: pick.id, dueAt: windowStart });
  }
  return changes;
}

/** A card that is due now (possibly long overdue). */
export type DueCard = { id: string; conceptId: string; state: MemoryState };

/**
 * Today's share of the due cards, weakest concepts first:
 * `min(perDay, ceil(n / daysLeft))` cards. Never the whole pile.
 */
export function spreadBacklog<C extends DueCard>(
  dueCards: readonly C[],
  examAt: Time,
  now: Time,
  perDay: number,
): C[] {
  const exam = ms(examAt);
  const t0 = ms(now);
  const n = dueCards.length;
  if (t0 >= exam || n === 0 || perDay <= 0) return [];

  const daysLeft = Math.max(1, Math.ceil((exam - t0) / DAY));
  const share = Math.min(Math.floor(perDay), Math.ceil(n / daysLeft));

  const nowDate = new Date(t0);
  const scored = dueCards.map((c) => ({ c, r: recallAt(c.state, nowDate) }));
  const sums = new Map<string, { sum: number; count: number }>();
  for (const { c, r } of scored) {
    const s = sums.get(c.conceptId) ?? { sum: 0, count: 0 };
    s.sum += r;
    s.count += 1;
    sums.set(c.conceptId, s);
  }
  const conceptRecall = (id: string) => {
    const s = sums.get(id)!;
    return s.sum / s.count;
  };

  return scored
    .sort(
      (a, b) =>
        conceptRecall(a.c.conceptId) - conceptRecall(b.c.conceptId) ||
        compareIds(a.c.conceptId, b.c.conceptId) ||
        a.r - b.r ||
        compareIds(a.c.id, b.c.id),
    )
    .slice(0, share)
    .map(({ c }) => c);
}

/** A card missed 4 times stops repeating (it drops a rung instead). */
export function isLeech(state: MemoryState): boolean {
  return state.lapses >= LEECH_LAPSES;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

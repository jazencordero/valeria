/*
 * Demo deck (M3-40): the prototype's two exams with their concepts, cards and
 * review history, for the demo account.
 *
 *   await seedStudy(userId, now, db);   // called by seedDemo after the sync
 *   planExam(exam, now);                // the pure plan behind it (tests)
 *
 * Data: `tests/fixtures/study/demo-deck.json`, copied from the prototype's
 * EXAM_DATA and CARD_DATA (main-flow.html, lines 2484 to 2571). Every card goes
 * through `parseCard`; one that fails stops the seed. Demo content only.
 *
 * Dates are relative to `now` in Helsinki: the exam is today + 6 at 09:00, the
 * quiz today + 13 at 12:00 (the prototype's FRI 20 and FRI 27 seen from
 * Saturday 14 November).
 *
 * Memory: nothing is written straight into `card_states`. The seed writes
 * review rows and `card_states` is what replaying them gives with
 * `memory.grade` (the same replay `recordReviews` and examView's history do),
 * so the chart, today's forecast and her next review all agree.
 *
 * - Targets. A concept's mastery is the mean predicted recall on exam day of
 *   its cards (`conceptMastery`). Boss cards stay unseen, as in the prototype
 *   (they are exam-style questions she has not reached), so each other card of
 *   the concept aims at `mastery * cards / non-boss cards`. The exam's
 *   Sourcing concept: 0.55 * 4 / 3; Strategic alignment: 0.42 * 2 / 1.
 * - Days. `heat[i]` reviews on day `i - 13` (index 12 is yesterday), so the
 *   last-14 chart shows the prototype's counts exactly. One extra study day,
 *   14 days ago (outside that chart), is her head start: it is why the forecast
 *   chart opens at `hist[0]` and not at 0.
 * - Which cards. Cards open in study order (concept order, then deck order).
 *   On the head start the next card opens while that brings the forecast
 *   nearer `hist[0]` (a card counted at its target); from then on the rest open
 *   as soon as a day has room, so every card has several reviews to tune. A
 *   day's other slots go to seen cards, least recently reviewed first; with
 *   more slots than cards a card comes back later in the session.
 * - Grades: a search. The review times are fixed by the step above; only the
 *   grades (1 to 4 each) are searched, because FSRS-7's forgetting curve is
 *   nearly flat over a week (one Good gives about 0.84 on exam day, an Again
 *   about 0.4; moving a review by hours changes recall by under 0.01), so the
 *   grade, not the elapsed time, is what moves predicted recall
 *   (`memory.recallAt` at the exam's time). Three steps:
 *   1. Per card, a beam search (width `BEAM`, kept varied by recall and
 *      stability) over its grades. Each review aims at the card's target
 *      scaled by `hist` that day over the final forecast, so the chart climbs
 *      instead of jumping; the last review aims at the target itself
 *      (`LAST_WEIGHT`), and before it `LOOKAHEAD` keeps paths that can still
 *      land. The best `PER_CARD` paths go on.
 *   2. Per concept, every mix of one path per card, scored by how near the
 *      concept's mastery lands to the prototype's; another rung than the
 *      prototype's counts as a full miss. The best `COMBOS` go on.
 *   3. One mix per concept, adding the forecast's miss (`FORECAST_WEIGHT`).
 *   Grades are coarse, so single-card concepts land only near their mastery
 *   (Value and investment about 0.18 for 0.25, same rung); the exam's forecast
 *   lands within about a point of the prototype's 53 % (tested within 2).
 * - Not exact: `hist` rises on some days with no reviews (and is flat on some
 *   with reviews). Replayed memory only changes on review days, so the chart
 *   follows `hist` only roughly; `heat` is exact.
 * - Each study day is one finished `bite` session holding that day's reviews
 *   (the exam at 17:00, the quiz at 19:00 Helsinki, one card every 45 s), so
 *   none of them counts as today's bite.
 * - Origin `manual` (the schema's `CARD_ORIGINS` has no demo origin), the same
 *   as a hand-made imported deck. Cards are created in the JSON's order (a
 *   second apart, before the head start), so deck order is the prototype's.
 *
 * Idempotent: the deck's exams for this user (same course and title) are
 * deleted first, with everything under them (on delete cascade), then written
 * again, in one transaction. The demo reset deletes the whole user and seeds a
 * fresh one, so this matters only for a seed run twice on one user.
 */
import { and, eq, ilike, inArray } from "drizzle-orm";
import deckJson from "../../../tests/fixtures/study/demo-deck.json";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { cardConcepts, cards, cardStates, concepts, exams, reviews, studySessions } from "@/server/db/schema/study";
import { contentHash, parseCard, type Card } from "@/lib/study/card-schema";
import { aimedDue } from "@/lib/study/exam-aim";
import { conceptMastery, rungOf } from "@/lib/study/ladder";
import { forecastNow } from "@/lib/study/forecast";
import { GRADES, grade as gradeMemory, newCard, recallAt, type Grade, type MemoryState } from "@/lib/study/memory";

const ZONE = "Europe/Helsinki";
const SECOND = 1000;

/** Beam width of the grade search. */
export const BEAM = 48;
/** How much more the last review's miss counts than the others in the search. */
export const LAST_WEIGHT = 25;
/** Weight in the search of how far a path is from the final target before its last review. */
export const LOOKAHEAD = 2;
/** Candidates per card tried when combining a concept's cards. */
export const PER_CARD = 8;
/** Combinations per concept tried when fitting the forecast. */
export const COMBOS = 6;
/** Weight of the forecast's miss (as a 0..1 share) against the concepts' own misses. */
export const FORECAST_WEIGHT = 400;
/** Head start: days before today of the study day before the 13-day window. */
export const HEAD_START_DAYS = 14;
/** Seconds between two cards in a seeded session. */
const CARD_GAP_S = 45;
/** Session start, Helsinki wall clock, per exam kind. */
const SESSION_HOUR: Record<DemoExam["kind"], number> = { exam: 17, quiz: 19 };

// ---------------------------------------------------------------------------
// The fixture

export type DemoConcept = { id: string; name: string; lecture: string; weight: number; mastery: number };
export type DemoExam = {
  key: string;
  title: string;
  kind: "exam" | "quiz";
  course: string;
  daysAhead: number;
  hour: number;
  minute: number;
  target: number;
  hist: number[];
  heat: number[];
  concepts: DemoConcept[];
  cards: Record<string, unknown>[];
};
export type DemoDeck = { exams: DemoExam[] };

export const DEMO_DECK = deckJson as unknown as DemoDeck;

export type DemoCard = { id: string; card: Card };

/** The exam's cards through `parseCard`, in the fixture's order. Throws on the first that fails. */
export function demoCards(exam: DemoExam): DemoCard[] {
  return exam.cards.map((raw) => {
    const id = String(raw.id);
    const parsed = parseCard(raw);
    if (!parsed.ok) throw new Error(`demo card ${id}: ${parsed.problems.join("; ")}`);
    const known = new Set(exam.concepts.map((c) => c.id));
    for (const c of parsed.card.concepts) if (!known.has(c)) throw new Error(`demo card ${id}: unknown concept ${c}`);
    return { id, card: parsed.card };
  });
}

// ---------------------------------------------------------------------------
// Helsinki dates

function zoneParts(at: number) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

function offsetMs(at: number): number {
  const p = zoneParts(at);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/** The instant Helsinki's clock shows `hour:minute` on `now`'s day plus `days`. */
export function helsinkiAt(now: Date, days: number, hour: number, minute = 0): Date {
  const today = zoneParts(now.getTime());
  const guess = Date.UTC(today.year, today.month - 1, today.day + days, hour, minute);
  const first = guess - offsetMs(guess);
  return new Date(guess - offsetMs(first));
}

/** When the exam is, for `now`. */
export function examTime(exam: DemoExam, now: Date): Date {
  return helsinkiAt(now, exam.daysAhead, exam.hour, exam.minute);
}

// ---------------------------------------------------------------------------
// The plan (pure)

export type PlannedReview = { cardId: string; at: Date; grade: Grade };
export type PlannedDay = { daysAgo: number; reviews: PlannedReview[] };
export type ExamPlan = {
  examAt: Date;
  cards: DemoCard[];
  /** Study days, oldest first; each becomes one session. */
  days: PlannedDay[];
  /** Each graded card's memory after its reviews (boss cards have none). */
  states: Record<string, MemoryState>;
  /** Each concept's mastery from `states`, and the forecast from them. */
  mastery: Record<string, number>;
  forecast: number;
};

type Slot = { daysAgo: number; count: number; goal: number };

/** The days she studies, oldest first, with how many reviews and the forecast aimed at. */
function slotsOf(exam: DemoExam, final: number): Slot[] {
  const n = exam.heat.length;
  const head: Slot = { daysAgo: HEAD_START_DAYS, count: Infinity, goal: exam.hist[0] ?? 0 };
  const window = exam.heat.map((count, i) => ({
    daysAgo: n - i,
    count,
    goal: i === n - 1 ? final : exam.hist[i],
  }));
  return [head, ...window].filter((s) => s.count > 0 && (s.count !== Infinity || s.goal > 0));
}

type Candidate = { grades: Grade[]; recall: number; cost: number };

/**
 * One card's grade candidates for its review times: the beam search described
 * in the header. Returns the last beam, best first: grades, predicted recall
 * on exam day, and the path's miss on the day aims.
 */
function searchGrades(times: readonly Date[], aims: readonly number[], target: number, examAt: Date): Candidate[] {
  type Node = Candidate & { state: MemoryState | null; key: string };
  let beam: Node[] = [{ grades: [], state: null, recall: 0, cost: 0, key: "" }];
  times.forEach((at, k) => {
    const last = k === times.length - 1;
    const next: Node[] = [];
    for (const node of beam) {
      for (const g of GRADES) {
        const state = gradeMemory(node.state ?? newCard(at), g, at);
        const recall = recallAt(state, examAt);
        const cost = node.cost + (last ? 0 : (recall - aims[k]) ** 2);
        next.push({ grades: [...node.grades, g], state, recall, cost, key: node.key + g });
      }
    }
    // Before the last review, also how far it is from landing, so paths that can still land stay.
    const score = (n: Node) => n.cost + (last ? LAST_WEIGHT : LOOKAHEAD) * (n.recall - target) ** 2;
    next.sort((a, b) => score(a) - score(b) || (a.key < b.key ? -1 : 1));
    // Keep the beam varied: one path per (recall, stability) cell.
    const cells = new Set<string>();
    beam = [];
    for (const n of next) {
      const cell = `${Math.round(n.recall * 400)}:${Math.round(Math.log(n.state!.stability + 1e-6) * 20)}`;
      if (cells.has(cell)) continue;
      cells.add(cell);
      beam.push(n);
      if (beam.length >= BEAM) break;
    }
  });
  return beam.map(({ grades, recall, cost }) => ({ grades, recall, cost }));
}

type Combo = { picks: Candidate[]; mastery: number; score: number };

/**
 * A concept's options: combinations of one candidate per studied card, scored
 * by how near their mastery (mean recall over all the concept's cards, boss
 * cards at 0) lands to the prototype's, a rung other than the prototype's
 * counting as a full miss. Best `COMBOS` first.
 */
function conceptCombos(cands: readonly Candidate[][], cardsInConcept: number, mastery: number): Combo[] {
  const lists = cands.map((c) => c.slice(0, PER_CARD));
  const out: Combo[] = [];
  const walk = (i: number, chosen: Candidate[]) => {
    if (i === lists.length) {
      const m = chosen.reduce((s, c) => s + c.recall, 0) / cardsInConcept;
      const score =
        (rungOf(m) === rungOf(mastery) ? 0 : 1) +
        LAST_WEIGHT * (m - mastery) ** 2 +
        chosen.reduce((s, c) => s + c.cost, 0) / chosen.length;
      out.push({ picks: [...chosen], mastery: m, score });
      return;
    }
    for (const c of lists[i]) walk(i + 1, [...chosen, c]);
  };
  walk(0, []);
  return out.sort((a, b) => a.score - b.score).slice(0, COMBOS);
}

/** One combination per concept: the concepts' scores plus the forecast's miss (`FORECAST_WEIGHT`). */
function pickCombos(options: readonly Combo[][], weights: readonly number[], final: number): Combo[] {
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  let best: Combo[] = options.map((o) => o[0]);
  let bestScore = Infinity;
  const walk = (i: number, chosen: Combo[], score: number, sum: number) => {
    if (score >= bestScore) return;
    if (i === options.length) {
      const f = (100 * sum) / total;
      const all = score + FORECAST_WEIGHT * ((f - final) / 100) ** 2;
      if (all < bestScore) {
        bestScore = all;
        best = [...chosen];
      }
      return;
    }
    for (const o of options[i]) walk(i + 1, [...chosen, o], score + o.score, sum + weights[i] * o.mastery);
  };
  walk(0, [], 0, 0);
  return best;
}

/** Plans one exam's history for `now` (see the header). Pure and deterministic. */
export function planExam(exam: DemoExam, now: Date): ExamPlan {
  const examAt = examTime(exam, now);
  const deck = demoCards(exam);
  const totalWeight = exam.concepts.reduce((s, c) => s + c.weight, 0);
  const final = 100 * exam.concepts.reduce((s, c) => s + c.weight * c.mastery, 0) / (totalWeight || 1);

  // Each studied card's target and its share of the forecast once seen.
  const conceptOf = (d: DemoCard) => d.card.concepts[0];
  const target = new Map<string, number>();
  const share = new Map<string, number>();
  for (const c of exam.concepts) {
    const own = deck.filter((d) => conceptOf(d) === c.id);
    const studied = own.filter((d) => !d.card.boss);
    for (const d of studied) {
      const t = Math.min(0.97, (c.mastery * own.length) / studied.length);
      target.set(d.id, t);
      share.set(d.id, (100 * c.weight * t) / (own.length * (totalWeight || 1)));
    }
  }
  const order = exam.concepts.flatMap((c) => deck.filter((d) => conceptOf(d) === c.id && !d.card.boss));

  // Which card on which day.
  const slots = slotsOf(exam, final);
  const hour = SESSION_HOUR[exam.kind];
  // Order of each card's latest review (higher = more recent).
  const lastSeen = new Map<string, number>();
  let seq = 0;
  const times = new Map<string, Date[]>();
  const aims = new Map<string, number[]>();
  const days: PlannedDay[] = [];
  let opened = 0;
  let level = 0;
  slots.forEach((slot, si) => {
    const later = slots.slice(si + 1).reduce((s, x) => s + x.count, 0);
    const picks: string[] = [];
    const take = (id: string) => {
      picks.push(id);
      lastSeen.set(id, ++seq);
    };
    while (opened < order.length && picks.length < slot.count) {
      const next = order[opened];
      // The head start opens cards while that nears hist[0]; later days open the rest at once.
      const must = slot.count !== Infinity || order.length - opened > later;
      const nearer = level + share.get(next.id)! / 2 <= slot.goal;
      if (!must && !nearer) break;
      take(next.id);
      level += share.get(next.id)!;
      opened++;
    }
    const count = slot.count === Infinity ? picks.length : slot.count;
    const seen = order.slice(0, opened).map((d) => d.id);
    while (picks.length < count && seen.length > 0) {
      // Least recently reviewed first; ties in study order.
      take(seen.reduce((best, id) => (lastSeen.get(id)! < lastSeen.get(best)! ? id : best)));
    }
    const start = helsinkiAt(now, -slot.daysAgo, hour);
    const dayReviews = picks.map((cardId, i) => {
      const at = new Date(start.getTime() + i * CARD_GAP_S * SECOND);
      times.set(cardId, [...(times.get(cardId) ?? []), at]);
      aims.set(cardId, [...(aims.get(cardId) ?? []), target.get(cardId)! * Math.min(1, slot.goal / (final || 1))]);
      return { cardId, at, grade: 3 as Grade };
    });
    if (dayReviews.length > 0) days.push({ daysAgo: slot.daysAgo, reviews: dayReviews });
  });

  // Grades, then the memory they leave.
  const gradesOf = new Map<string, Grade[]>();
  const studiedOf = exam.concepts.map((c) => deck.filter((d) => conceptOf(d) === c.id && times.has(d.id)));
  const options = exam.concepts.map((c, i) => {
    const own = deck.filter((d) => conceptOf(d) === c.id).length;
    const cands = studiedOf[i].map((d) => searchGrades(times.get(d.id)!, aims.get(d.id)!, target.get(d.id)!, examAt));
    return conceptCombos(cands, own, c.mastery);
  });
  pickCombos(options, exam.concepts.map((c) => c.weight), final).forEach((combo, i) =>
    combo.picks.forEach((pick, k) => gradesOf.set(studiedOf[i][k].id, pick.grades)),
  );
  const used = new Map<string, number>();
  const states: Record<string, MemoryState> = {};
  for (const day of days) {
    for (const r of day.reviews) {
      const k = used.get(r.cardId) ?? 0;
      r.grade = gradesOf.get(r.cardId)![k];
      used.set(r.cardId, k + 1);
      states[r.cardId] = gradeMemory(states[r.cardId] ?? newCard(r.at), r.grade, r.at);
    }
  }

  const mastery: Record<string, number> = {};
  for (const c of exam.concepts) {
    const own = deck
      .filter((d) => conceptOf(d) === c.id)
      .map((d) => ({ state: states[d.id] ?? newCard(examAt), active: true }));
    mastery[c.id] = conceptMastery(own, examAt);
  }
  const forecast = forecastNow(exam.concepts.map((c) => ({ weight: c.weight, mastery: mastery[c.id] })));
  return { examAt, cards: deck, days, states, mastery, forecast };
}

// ---------------------------------------------------------------------------
// Writing it

export type SeedStudyResult = { exams: { key: string; id: string; forecast: number }[]; cards: number; reviews: number };

/** The card's body column: the card without the fields that have columns (as the bundle import stores it). */
function bodyOf(card: Card): Record<string, unknown> {
  const { type: _type, concepts: _concepts, rung: _rung, boss: _boss, why: _why, source: _source, ...body } = card;
  void [_type, _concepts, _rung, _boss, _why, _source];
  return body;
}

async function courseFor(tx: Db, userId: string, name: string): Promise<string> {
  const [row] = await tx
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.userId, userId), ilike(courses.name, `%${name}%`)))
    .orderBy(courses.name)
    .limit(1);
  if (!row) throw new Error(`seedStudy: no course named like "${name}" for this user; run the demo sync first.`);
  return row.id;
}

async function writeExam(tx: Db, userId: string, exam: DemoExam, now: Date): Promise<{ id: string; forecast: number; cards: number; reviews: number }> {
  const plan = planExam(exam, now);
  const courseId = await courseFor(tx, userId, exam.course);

  // Idempotent: this deck's exam, and everything under it, goes first.
  const old = await tx
    .select({ id: exams.id })
    .from(exams)
    .where(and(eq(exams.userId, userId), eq(exams.courseId, courseId), eq(exams.title, exam.title)));
  if (old.length > 0) await tx.delete(exams).where(inArray(exams.id, old.map((e) => e.id)));

  const [row] = await tx
    .insert(exams)
    .values({ userId, courseId, title: exam.title, kind: exam.kind, at: plan.examAt, targetPct: exam.target })
    .returning({ id: exams.id });

  const made = await tx
    .insert(concepts)
    .values(exam.concepts.map((c, i) => ({ userId, examId: row.id, name: c.name, lecture: c.lecture, position: i, weight: c.weight })))
    .returning({ id: concepts.id, position: concepts.position });
  const conceptId = new Map(made.map((m) => [exam.concepts[m.position].id, m.id]));

  // Made before the head start, a second apart, so deck order is the fixture's.
  const madeAt = helsinkiAt(now, -HEAD_START_DAYS - 1, 12).getTime();
  const inserted = await tx
    .insert(cards)
    .values(
      plan.cards.map(({ card }, i) => ({
        userId,
        examId: row.id,
        createdAt: new Date(madeAt + i * SECOND),
        type: card.type,
        rung: card.rung ?? 0,
        boss: card.boss,
        body: bodyOf(card),
        why: card.why ?? null,
        source: card.source,
        origin: "manual" as const,
        contentHash: contentHash(card),
      })),
    )
    .returning({ id: cards.id, hash: cards.contentHash });
  const idByHash = new Map(inserted.map((r) => [r.hash, r.id]));
  const cardId = new Map(plan.cards.map((d) => [d.id, idByHash.get(contentHash(d.card))!]));

  await tx
    .insert(cardConcepts)
    .values(plan.cards.flatMap((d) => d.card.concepts.map((c) => ({ cardId: cardId.get(d.id)!, conceptId: conceptId.get(c)! }))));

  // Memory: replayed reviews for the graded cards, a new card for the rest.
  const fresh = newCard(now);
  await tx.insert(cardStates).values(
    plan.cards.map((d) => {
      const fsrs = plan.states[d.id];
      if (!fsrs) return { cardId: cardId.get(d.id)!, fsrs: fresh, dueAt: new Date(fresh.dueAt), lapses: 0 };
      const last = new Date(fsrs.lastReviewAt ?? now.getTime());
      return {
        cardId: cardId.get(d.id)!,
        fsrs,
        dueAt: new Date(aimedDue(fsrs, plan.examAt, last) ?? fsrs.dueAt),
        lapses: fsrs.lapses,
        lastReviewAt: last,
      };
    }),
  );

  let reviewCount = 0;
  for (const day of plan.days) {
    const first = day.reviews[0].at.getTime();
    const lastAt = day.reviews[day.reviews.length - 1].at.getTime();
    const ids = [...new Set(day.reviews.map((r) => cardId.get(r.cardId)!))];
    const [session] = await tx
      .insert(studySessions)
      .values({
        userId,
        examId: row.id,
        mode: "bite",
        startedAt: new Date(first - 30 * SECOND),
        endedAt: new Date(lastAt + 30 * SECOND),
        summary: { cardIds: ids, cards: ids.length, reviews: day.reviews.length },
      })
      .returning({ id: studySessions.id });
    await tx.insert(reviews).values(
      day.reviews.map((r) => ({
        userId,
        cardId: cardId.get(r.cardId)!,
        sessionId: session.id,
        grade: r.grade,
        firstTry: true,
        ms: 20 * SECOND,
        at: r.at,
      })),
    );
    reviewCount += day.reviews.length;
  }
  return { id: row.id, forecast: plan.forecast, cards: plan.cards.length, reviews: reviewCount };
}

/**
 * Writes the demo deck for `userId` (see the header): both exams, their
 * concepts and cards, and the review history, dated from `now`. Needs the
 * demo's courses (the demo sync makes them).
 */
export async function seedStudy(userId: string, now: Date = new Date(), database: Db = defaultDb): Promise<SeedStudyResult> {
  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const out: SeedStudyResult = { exams: [], cards: 0, reviews: 0 };
    for (const exam of DEMO_DECK.exams) {
      const r = await writeExam(tx, userId, exam, now);
      out.exams.push({ key: exam.key, id: r.id, forecast: r.forecast });
      out.cards += r.cards;
      out.reviews += r.reviews;
    }
    return out;
  });
}

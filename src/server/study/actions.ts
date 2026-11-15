"use server";
/**
 * Study actions the screens call (ticket M3-18): the exam page and cards,
 * a study session from start to done screen, and the grade-button setting.
 *
 * Every action reads the signed-in user from the session cookie
 * (`currentUser`, which throws `NotSignedIn`) and only touches that user's
 * rows. Another user's exam or session is refused with `StudyNotFound` from
 * `./store`, exactly like an id that does not exist. Storage goes through
 * `./store`; the rules are the pure modules in `src/lib/study`.
 *
 * This is a `"use server"` file, so every export is callable from the
 * browser. That is why only the five actions are exported: the helpers below
 * take a `userId` and must never be reachable with an id the caller chose.
 * Tests drive the actions themselves with the session and the database
 * handle mocked (see `actions.test.ts`). Arguments come from the browser, so
 * each action checks them before use.
 *
 * Choices:
 * - Deck. A card's concept for mastery is its first linked concept (concepts
 *   are in `position` order); a card with no concept counts for none. A
 *   card's rung is its stored `rung` clamped to 1..5. A concept's `order` is
 *   its position in the exam. The same mapping feeds `bite.ts`, so the
 *   mastery shown and the mastery a bite is built from are the same numbers.
 *   `core` and `first` come from `cards.body` (true only when stored as true),
 *   so a seeded deck gets the study order in `bite.ts`. Session cards return
 *   the body as stored, so they carry them (and cloze `accept`) too.
 * - Study start (M3-53). Before the exam's `start_new_on` day (Helsinki,
 *   `newCardsAllowed` in `./start-date`) no session introduces a card she has
 *   never graded: every session kind is built from `studyDeck`, the deck
 *   without its never-graded cards. Cards she has graded are reviewed as
 *   usual, so before that day a fresh imported exam has no bite at all, and
 *   from that day it has one. Cards she made from her own notes (origin
 *   `note`, M9-25) are never held: they are offered from the day she makes
 *   them. The forecast, the concepts' mastery and the
 *   "new" count still read the whole deck. The importer also sets a new
 *   card's first due date to that day (M3-51), which is left as it is.
 * - Days left are whole Helsinki calendar days to the exam (`daysBetween`),
 *   as the chart and the phase bar use them.
 * - Forecast: `deckForecast` (raw) and `forecastShown` (rounded).
 * - Plan (`src/lib/study/plan.ts`). `ExamView.plan` is the exam's one pace
 *   and its projection, a simulation of the bites the app will serve with the
 *   same model as the forecast, made from the whole deck. `planEnd` is its
 *   last point and `verdict` is `verdictOf` over it (before start, ready, on
 *   track, reachable, not reachable), so the chip, the plan sentence, the
 *   chart and Home say the same pace and the same number. An exam that is
 *   over, or whose study start is still ahead, promises no pace: its plan is
 *   flat (`flatPlan`) and the screens say one line instead.
 * - Readiness model: `deckMasteries` in `src/lib/study/forecast.ts` (core
 *   cards first for a deck with core marks).
 * - A bite's `gain` is measured on the whole deck (`gainOf`): the forecast if
 *   each of its cards is recalled, minus the forecast now.
 * - History (the chart's days before today). There is no table of daily
 *   snapshots, so they are rebuilt: her reviews of the exam's active cards
 *   are replayed in time order with `memory.grade` (the same deterministic
 *   scheduler that wrote `card_states`), and each Helsinki day with reviews
 *   before today gives one snapshot of every concept's mastery at the end of
 *   that day. A snapshot for yesterday is added (same masteries) so the
 *   13-day window ends yesterday even after days off. `history()` does the
 *   rest; today's value is `forecast`, not part of `history`.
 * - Today's bite and "another bite is left": `buildBite` with
 *   `bitesDoneToday` (bite sessions for the exam that ended today). It is
 *   null once `BITES_PER_DAY[kind]` bites are done (2 for an exam, 1 for a
 *   quiz) or when the deck has nothing for a bite, so `anotherBite` on the
 *   done screen is simply "the next `buildBite` is not null".
 * - Core-first pace (`src/lib/study/pace.ts`), for an exam whose deck has
 *   core marks. The deck handed to every session builder then carries the
 *   exam's kind and the cards she met for the first time today (a card whose
 *   last review is today and that has no review before today), so today's
 *   budget of new cards stays the same all day. `ExamView.pace` is set for
 *   such an exam and only then: the bites that keep her on plan today, and
 *   `done`, which is "no bite is left and the study start has passed" (the
 *   number of bites done never ends the day for it). `bitesPerDay` is left as
 *   it is for other exams and means nothing here.
 * - Due dates. `recordReviews` grades with FSRS and writes the FSRS due date.
 *   `saveProgress` then aims it at the exam: `due_at = aimedDue(fsrs,
 *   examAt, lastReviewAt)`, which only ever moves it earlier; when aiming
 *   gives null (the exam has started, or the review cannot be pulled before
 *   it) the FSRS date stays, as in `bite.ts`. The `fsrs` JSON is left as
 *   FSRS made it, so the replay above still matches it. Aiming is computed
 *   from the stored state and its own review time, so sending the same batch
 *   again gives the same `due_at`. It is a second statement after the
 *   review transaction: if it fails, the card keeps its FSRS date (never
 *   later than intended by more than the aim) and the screen's retry of the
 *   same batch applies it.
 * - Button intervals (`beginSession`): for each grade, the time from now to
 *   the due date that grade would give, aimed the same way. The two-button
 *   mode uses grades 1 (Missed) and 3 (Got it).
 * - Forecast before and after (`endSession`). `beginSession` stores the
 *   forecast and every concept's mastery at the start in the session's
 *   `summary` (`forecastBefore`, `masteryBefore`); `endSession` computes the
 *   same numbers from the stored states now. "What moved" is every concept
 *   that rose by more than 0.004, biggest rung jump first, then biggest gain
 *   (the rule of `climbsOf` in `session.ts`). A session without stored
 *   "before" numbers counts as nothing moved.
 * - Done-screen stats come from the stored reviews of the session: unique
 *   cards, grades, seconds from start to the last grade, the best run of
 *   first-try passes (a grade of 1 or 2 breaks it, as in `session.ts`), and
 *   perfect (no grade of 1, and first-try passes on all but at most one
 *   card). They are kept in the summary through `finishSession`; ending a
 *   session twice keeps the first end time.
 * - Grade mode is `users.settings.gradeMode`, `'two'` (Missed / Got it, the
 *   default) or `'anki'` (Again / Hard / Good / Easy). Other settings keys
 *   are kept.
 * - Study week: `weekOf` over her review days this week (all exams), with
 *   the fixed goal of 4, or every day until the exam while this exam is 1 to
 *   14 days away (`goalFor`), plus the streak line (none at 0 weeks).
 * - Cut: no offline queue. `saveProgress` is idempotent (the store skips
 *   reviews it already has), so the screen retries a failed save three times
 *   with the same batch, then tells her.
 */
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { currentUser } from "@/server/auth/session";
import { setFlash } from "@/server/data/flash";
import { db, type Db } from "@/server/db/client";
import { cards, cardStates, CARD_TYPES, exams, reviews, SESSION_MODES, studySessions } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { byDay, dayMonth, daysBetween, startOfDay, startOfWeek } from "@/lib/dates";
import {
  BITES_PER_DAY,
  buildBite,
  conceptSession,
  extraSession,
  tileSession,
  type Bite,
  type BiteCard,
  type CardType,
  type Deck as BiteDeck,
  type SectionKind,
} from "@/lib/study/bite";
import { aimedDue } from "@/lib/study/exam-aim";
import {
  deckForecast,
  deckMasteries,
  gainOf,
  history,
  type DailySnapshot,
  type Verdict,
} from "@/lib/study/forecast";
import {
  focusConcept,
  phaseOf,
  phasePosition,
  rungName,
  rungOf,
  type Phase,
  type RungLevel,
} from "@/lib/study/ladder";
import { isPaced, paceOf } from "@/lib/study/pace";
import { flatPlan, keepWords, planOf, verdictOf, type Plan } from "@/lib/study/plan";
import { GRADES, grade as gradeMemory, intervalLabel, newCard, type Grade, type MemoryState } from "@/lib/study/memory";
import type { SessionMode } from "@/lib/study/session";
import { DEFAULT_GOAL, freeSkipsLeft, goalFor, streakLine, weekOf, weeksInARow, type Week } from "@/lib/study/week";
import { newCardsAllowed } from "./start-date";
import {
  bitesDoneToday,
  countsToday,
  dayKey,
  finishSession,
  last14,
  loadDeck,
  recordReviews,
  reviewDays,
  startSession,
  StudyNotFound,
  upcoming,
  type DayCount,
  type Deck,
  type ReviewInput,
  type TodayCounts,
} from "./store";

// ---------------------------------------------------------------------------
// Types the screens read

export type GradeMode = "two" | "anki";

export type ExamKind = "exam" | "quiz";

export type ConceptView = {
  id: string;
  name: string;
  lecture: string | null;
  icon: string | null;
  weight: number;
  /** 0..1, predicted recall on exam day. */
  mastery: number;
  rung: RungLevel;
  rungName: string;
};

export type TodayBite = Bite & { cards: number };

export type StudyWeek = Week & { weeksInARow: number; freeSkipsLeft: 0 | 1; streakLine: string };

/** Today's core-first pace, for an exam whose deck has core marks (`src/lib/study/pace.ts`). */
export type PaceView = {
  /** New cards may be served today (false past the cut-off). */
  open: boolean;
  /** New cards today's plan serves. */
  budget: number;
  /** New cards the plan still serves today. */
  left: number;
  /** Bites the plan still asks of today (`askedToday`): new-card bites, or past the cut-off the review bites. */
  bites: number;
  /** The days left cannot hold the core cards: said plainly instead of "on track". */
  impossible: boolean;
  /** Today's plan is done: no bite is left (the budget is used and nothing is due). */
  done: boolean;
};

export type ExamView = {
  exam: { id: string; title: string; kind: ExamKind; at: Date; targetPct: number; courseId: string };
  daysLeft: number;
  /** Forecast today, 0..100, not rounded (the chart draws this). */
  forecast: number;
  /** Forecast as screens show it, a whole percent. */
  forecastShown: number;
  /** Forecast on each day before today with data, oldest first, at most 13. */
  history: number[];
  /** The exam's one pace and its projection, day by day to exam day (`planOf`). */
  plan: Plan;
  /** Where that pace lands on exam day, in percent, not rounded: the last point of `plan.curve`. */
  planEnd: number;
  /** From the same plan (`verdictOf`): it never says on track when the plan ends below the target. */
  verdict: Verdict;
  phase: Phase;
  /** 0..100, the "you are here" marker on the phase bar. */
  phasePosition: number;
  concepts: ConceptView[];
  focusConcept: ConceptView | null;
  /** Today's bite, or null when today's plan is done or the deck is empty. */
  bite: TodayBite | null;
  bitesDoneToday: number;
  bitesPerDay: number;
  /** Set only for a paced exam; then `bitesPerDay` does not end the day. */
  pace?: PaceView;
  counts: TodayCounts;
  /** Graded cards per due day from today on. */
  nextReviews: DayCount[];
  /** Reviews per day for the 14 days ending today, oldest first. */
  last14: DayCount[];
  week: StudyWeek;
  gradeMode: GradeMode;
};

export type IntervalPreview = Record<Grade, { ms: number; label: string }>;

export type SessionCardView = {
  id: string;
  type: CardType;
  boss: boolean;
  section: SectionKind;
  conceptIds: string[];
  rung: number;
  body: unknown;
  why: string | null;
  source: string | null;
  /** What each grade button would schedule, from now. */
  intervals: IntervalPreview;
};

export type BegunSession = {
  sessionId: string;
  mode: SessionMode;
  minutes: number;
  /** Forecast points the session is worth if every card is recalled, not rounded. */
  gain: number;
  cards: SessionCardView[];
  gradeMode: GradeMode;
};

export type SavedProgress = {
  stored: number;
  skipped: number;
  /** When each card in the batch is next due (exam-aimed). */
  due: { cardId: string; dueAt: Date }[];
};

export type ConceptMove = {
  id: string;
  name: string;
  from: number;
  to: number;
  rungFrom: RungLevel;
  rungTo: RungLevel;
};

export type SessionStats = {
  /** Unique cards graded. */
  cards: number;
  /** Grades given (a requeued card counts each time). */
  reviews: number;
  missed: number;
  seconds: number;
  best: number;
  perfect: boolean;
};

export type DoneScreen = {
  sessionId: string;
  examId: string;
  mode: SessionMode;
  stats: SessionStats;
  forecastBefore: number;
  forecastAfter: number;
  forecastBeforeShown: number;
  forecastAfterShown: number;
  /** Where the exam's pace lands on exam day after this session, a whole percent (`planOf`). */
  planEnd: number;
  /** The pace as the done screen starts its sentence: "Keep a bite a day", "Keep to the plan". */
  planLead: string;
  moved: ConceptMove[];
  week: StudyWeek;
  bitesDoneToday: number;
  bitesPerDay: number;
  /** True when another bite is left today (see the header). */
  anotherBite: boolean;
};

// ---------------------------------------------------------------------------
// Actions

/** Everything the exam page and the exam cards need. */
export async function examView(examId: string): Promise<ExamView> {
  const user = await currentUser();
  return buildExamView(user.id, String(examId), new Date(), db);
}

/**
 * Starts a session: `kind` is `bite` (today's bite; `arg` unused), `tile`
 * (`arg` is a card type), `concept` (`arg` is a concept id) or `extra`.
 * Returns null when there is nothing to study (today's bites are done, or no
 * card fits); no session row is written then.
 */
export async function beginSession(examId: string, kind: SessionMode, arg?: string): Promise<BegunSession | null> {
  const user = await currentUser();
  return begin(user.id, String(examId), kind, arg, new Date(), db);
}

/**
 * Stores the grades given so far. Called after every card with the reviews
 * not yet confirmed; sending a review again is harmless.
 */
export async function saveProgress(sessionId: string, batch: ReviewInput[]): Promise<SavedProgress> {
  const user = await currentUser();
  return save(user.id, String(sessionId), batch, new Date(), db);
}

/** Ends a session and returns the done screen. Ending it twice is harmless. */
export async function endSession(sessionId: string): Promise<DoneScreen> {
  const user = await currentUser();
  const done = await end(user.id, String(sessionId), new Date(), db);
  // Home greets her once with the forecast she just moved (M4-15).
  await setFlash("studied", { examId: done.examId, forecast: done.forecastAfterShown });
  return done;
}

/** Two buttons (Missed / Got it) or four (Anki mode). */
export async function setGradeMode(mode: GradeMode): Promise<GradeMode> {
  if (mode !== "two" && mode !== "anki") throw new Error(`setGradeMode: unknown mode ${String(mode)}`);
  const user = await currentUser();
  await db
    .update(users)
    .set({ settings: sql`${users.settings} || jsonb_build_object('gradeMode', ${mode}::text)` })
    .where(eq(users.id, user.id));
  return mode;
}

// ---------------------------------------------------------------------------
// Loading

type Exam = typeof exams.$inferSelect;
type Session = typeof studySessions.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadExam(userId: string, examId: string, database: Db): Promise<Exam> {
  if (!UUID.test(examId)) throw new StudyNotFound("exam", examId);
  const [row] = await database
    .select()
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)));
  if (!row) throw new StudyNotFound("exam", examId);
  return row;
}

async function loadSession(userId: string, sessionId: string, database: Db): Promise<Session> {
  if (!UUID.test(sessionId)) throw new StudyNotFound("session", sessionId);
  const [row] = await database
    .select()
    .from(studySessions)
    .where(and(eq(studySessions.id, sessionId), eq(studySessions.userId, userId)));
  if (!row) throw new StudyNotFound("session", sessionId);
  return row;
}

async function gradeModeOf(userId: string, database: Db): Promise<GradeMode> {
  const [row] = await database.select({ settings: users.settings }).from(users).where(eq(users.id, userId));
  return row?.settings?.gradeMode === "anki" ? "anki" : "two";
}

// ---------------------------------------------------------------------------
// The deck as the pure modules see it

type ExamState = {
  exam: Exam;
  deck: Deck;
  biteDeck: BiteDeck;
  /** What sessions are built from: `biteDeck`, without never-graded cards before the study start. */
  studyDeck: BiteDeck;
  concepts: ConceptView[];
  forecast: number;
};

const clampRung = (r: number) => Math.min(5, Math.max(1, Math.round(r))) as BiteCard["rung"];

/** A true/false mark the card format keeps in `cards.body` (M3-52); anything but `true` is false. */
const flagOf = (body: unknown, key: "core" | "first") =>
  typeof body === "object" && body !== null && (body as Record<string, unknown>)[key] === true;

function toBiteDeck(deck: Deck, exam: Exam, now: Date): BiteDeck {
  const examAt = exam.at;
  const states: Record<string, MemoryState> = {};
  for (const c of deck.cards) if (c.memory) states[c.id] = c.memory.fsrs;
  return {
    cards: deck.cards.map((c) => ({
      id: c.id,
      conceptId: c.conceptIds[0] ?? "",
      conceptIds: c.conceptIds,
      rung: clampRung(c.rung),
      type: c.type,
      boss: c.boss,
      active: c.status === "active",
      core: flagOf(c.body, "core"),
      first: flagOf(c.body, "first"),
    })),
    states,
    concepts: deck.concepts.map((c, i) => ({ id: c.id, weight: c.weight, order: i })),
    examAt,
    now,
    kind: exam.kind,
  };
}

/**
 * The cards she met for the first time today (Helsinki day): last graded
 * today, and no review before today.
 */
async function newTodayIds(userId: string, deck: BiteDeck, now: Date, database: Db): Promise<string[]> {
  const start = startOfDay(now);
  const today = deck.cards.map((c) => c.id).filter((id) => (deck.states[id]?.lastReviewAt ?? 0) >= start.getTime());
  if (today.length === 0) return [];
  const earlier = await database
    .selectDistinct({ cardId: reviews.cardId })
    .from(reviews)
    .where(and(eq(reviews.userId, userId), inArray(reviews.cardId, today), lt(reviews.at, start)));
  const seenBefore = new Set(earlier.map((r) => r.cardId));
  return today.filter((id) => !seenBefore.has(id));
}

/**
 * The deck sessions may draw from: before the exam's study start, only cards
 * she has graded, plus every card she made from her own notes (M9-25).
 */
function studyDeckOf(exam: Exam, deck: Deck, biteDeck: BiteDeck, now: Date): BiteDeck {
  if (newCardsAllowed(exam, now)) return biteDeck;
  const fromNote = new Set(deck.cards.filter((c) => c.origin === "note").map((c) => c.id));
  const graded = (id: string) => (biteDeck.states[id]?.lastReviewAt ?? null) !== null;
  return { ...biteDeck, cards: biteDeck.cards.filter((c) => fromNote.has(c.id) || graded(c.id)) };
}

async function examState(userId: string, examId: string, now: Date, database: Db): Promise<ExamState> {
  const exam = await loadExam(userId, examId, database);
  const deck = await loadDeck(userId, examId, database);
  let biteDeck = toBiteDeck(deck, exam, now);
  // A paced deck (core marks): what today's budget needs, and the mark itself, which the
  // study-start cut below could hide.
  if (isPaced(biteDeck)) {
    biteDeck = { ...biteDeck, coreMarked: true, newToday: await newTodayIds(userId, biteDeck, now, database) };
  }
  const mastery = deckMasteries(biteDeck);
  const concepts = deck.concepts.map((c): ConceptView => {
    const m = mastery[c.id] ?? 0;
    const rung = rungOf(m);
    return { id: c.id, name: c.name, lecture: c.lecture, icon: c.icon, weight: c.weight, mastery: m, rung, rungName: rungName(rung) };
  });
  return { exam, deck, biteDeck, studyDeck: studyDeckOf(exam, deck, biteDeck, now), concepts, forecast: deckForecast(biteDeck) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function previousDay(key: string): string {
  return new Date(Date.parse(`${key}T12:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/** Daily mastery snapshots rebuilt from her reviews (see the header). */
async function snapshots(userId: string, state: ExamState, now: Date, database: Db): Promise<DailySnapshot[]> {
  const ids = state.biteDeck.cards.map((c) => c.id);
  if (ids.length === 0) return [];
  const rows = await database
    .select({ cardId: reviews.cardId, grade: reviews.grade, at: reviews.at })
    .from(reviews)
    .where(and(eq(reviews.userId, userId), inArray(reviews.cardId, ids)))
    .orderBy(asc(reviews.at), asc(reviews.id));

  const today = dayKey(now);
  const memory: Record<string, MemoryState> = {};
  const out: DailySnapshot[] = [];
  let day: string | null = null;
  for (const r of rows) {
    const key = dayKey(r.at);
    if (key >= today) break;
    if (day !== null && key !== day) out.push({ day, mastery: deckMasteries(state.biteDeck, memory) });
    day = key;
    memory[r.cardId] = gradeMemory(memory[r.cardId] ?? newCard(r.at), r.grade as Grade, r.at);
  }
  if (day !== null) {
    const last = { day, mastery: deckMasteries(state.biteDeck, memory) };
    out.push(last);
    const yesterday = previousDay(today);
    if (day < yesterday) out.push({ day: yesterday, mastery: last.mastery });
  }
  return out;
}

/** `examAt`: the exam this week is shown for; within 14 days of it the goal is every day (`goalFor`). */
async function studyWeek(userId: string, now: Date, database: Db, examAt: Date | null = null): Promise<StudyWeek> {
  // Weeks in a row looks back week by week; a year of review days is plenty.
  const days = await reviewDays(userId, new Date(startOfWeek(now).getTime() - 53 * 7 * DAY_MS), database);
  const week = weekOf(days, goalFor(days, examAt, now), now);
  const weeks = weeksInARow(days, DEFAULT_GOAL, now);
  const skips = freeSkipsLeft(days, DEFAULT_GOAL, now);
  return { ...week, weeksInARow: weeks, freeSkipsLeft: skips, streakLine: streakLine(weeks, skips) };
}

/** The session's gain measured on the whole deck (the study-start cut may have hidden part of it). */
function measured(state: ExamState, bite: Bite | null): Bite | null {
  return bite ? { ...bite, gain: gainOf(state.biteDeck, bite.sections.flatMap(([, ids]) => ids)) } : null;
}

function todayBite(state: ExamState, done: number): Bite | null {
  return measured(state, buildBite({ ...state.studyDeck, kind: state.exam.kind, bitesDoneToday: done }));
}

/** The exam's plan now; flat when no pace is promised (over, or before the study start). */
function planFor(state: ExamState, now: Date, done: number): Plan {
  const { exam, biteDeck } = state;
  if (daysBetween(now, exam.at) < 0 || !newCardsAllowed(exam, now)) return flatPlan(biteDeck, exam.targetPct);
  return planOf(biteDeck, exam.targetPct, done);
}

const sizeOf = (b: Bite) => b.sections.reduce((n, [, ids]) => n + ids.length, 0);

// ---------------------------------------------------------------------------
// examView

async function buildExamView(userId: string, examId: string, now: Date, database: Db): Promise<ExamView> {
  const state = await examState(userId, examId, now, database);
  const { exam } = state;
  const [done, counts, next, recent, week, gradeMode, snaps] = await Promise.all([
    bitesDoneToday(userId, examId, now, database),
    countsToday(userId, examId, now, database),
    upcoming(userId, examId, now, database),
    last14(userId, examId, now, database),
    studyWeek(userId, now, database, exam.at),
    gradeModeOf(userId, database),
    snapshots(userId, state, now, database),
  ]);
  const daysLeft = daysBetween(now, exam.at);
  const shown = Math.round(state.forecast);
  const plan = planFor(state, now, done);
  // Past its day (whole-day or not): the exam is over, so no bite is offered.
  const bite = daysLeft < 0 ? null : todayBite(state, done);
  const pace = paceOf(state.studyDeck);
  return {
    exam: { id: exam.id, title: exam.title, kind: exam.kind, at: exam.at, targetPct: exam.targetPct, courseId: exam.courseId },
    daysLeft,
    forecast: state.forecast,
    forecastShown: shown,
    history: history(snaps, state.deck.concepts.map((c) => ({ id: c.id, weight: c.weight }))),
    plan,
    planEnd: plan.end,
    verdict: verdictOf(shown, exam.targetPct, plan, {
      day: byDay(exam.at, now),
      // Before the study start (not for an exam that is over): the day it opens, "Tue 24 Nov".
      starts:
        daysLeft >= 0 && exam.startNewOn && !newCardsAllowed(exam, now)
          ? dayMonth(`${exam.startNewOn.slice(0, 10)}T12:00:00Z`)
          : null,
    }),
    phase: phaseOf(daysLeft),
    phasePosition: phasePosition(daysLeft),
    concepts: state.concepts,
    focusConcept: focusConcept(state.concepts),
    bite: bite ? { ...bite, cards: sizeOf(bite) } : null,
    bitesDoneToday: done,
    bitesPerDay: BITES_PER_DAY[exam.kind],
    ...(pace
      ? {
          pace: {
            open: pace.open,
            budget: pace.budget,
            left: pace.left,
            bites: plan.pace.kind === "core" ? plan.pace.bitesToday : pace.bites,
            impossible: pace.impossible,
            done: bite === null && daysLeft >= 0 && newCardsAllowed(exam, now) && state.biteDeck.cards.length > 0,
          },
        }
      : {}),
    counts,
    nextReviews: next,
    last14: recent,
    week,
    gradeMode,
  };
}

// ---------------------------------------------------------------------------
// beginSession

function aimed(state: MemoryState, examAt: Date, at: Date): number {
  return aimedDue(state, examAt, at) ?? state.dueAt;
}

function intervalsFor(state: MemoryState, examAt: Date, now: Date): IntervalPreview {
  const out = {} as IntervalPreview;
  for (const g of GRADES) {
    const ms = Math.max(0, aimed(gradeMemory(state, g, now), examAt, now) - now.getTime());
    out[g] = { ms, label: intervalLabel(ms) };
  }
  return out;
}

async function begin(
  userId: string,
  examId: string,
  kind: SessionMode,
  arg: string | undefined,
  now: Date,
  database: Db,
): Promise<BegunSession | null> {
  if (!(SESSION_MODES as readonly string[]).includes(kind)) throw new Error(`beginSession: unknown kind ${String(kind)}`);
  const state = await examState(userId, examId, now, database);
  const biteDeck = state.studyDeck;

  let bite: Bite | null;
  if (kind === "bite") {
    bite = todayBite(state, await bitesDoneToday(userId, examId, now, database));
  } else if (kind === "tile") {
    if (!(CARD_TYPES as readonly string[]).includes(String(arg))) throw new Error(`beginSession: unknown card type ${String(arg)}`);
    bite = tileSession(biteDeck, arg as CardType);
  } else if (kind === "concept") {
    if (!state.deck.concepts.some((c) => c.id === arg)) throw new Error(`beginSession: no concept ${String(arg)} in this exam`);
    bite = conceptSession(biteDeck, String(arg));
  } else {
    bite = extraSession(biteDeck);
  }
  bite = measured(state, bite);
  if (!bite) return null;

  const ids = bite.sections.flatMap(([, list]) => list);
  const session = await startSession(userId, examId, kind, ids, now, database);
  const masteryBefore = Object.fromEntries(state.concepts.map((c) => [c.id, c.mastery]));
  await database
    .update(studySessions)
    .set({ summary: { ...(session.summary as Record<string, unknown>), forecastBefore: state.forecast, masteryBefore } })
    .where(eq(studySessions.id, session.id));

  const byId = new Map(state.deck.cards.map((c) => [c.id, c]));
  const cardsOut: SessionCardView[] = [];
  for (const [section, list] of bite.sections) {
    for (const id of list) {
      const c = byId.get(id)!;
      const memory = c.memory?.fsrs ?? newCard(now);
      cardsOut.push({
        id,
        type: c.type,
        boss: c.boss,
        section,
        conceptIds: c.conceptIds,
        rung: c.rung,
        body: c.body,
        why: c.why,
        source: c.source,
        intervals: intervalsFor(memory, state.exam.at, now),
      });
    }
  }
  return {
    sessionId: session.id,
    mode: kind,
    minutes: bite.minutes,
    gain: bite.gain,
    cards: cardsOut,
    gradeMode: await gradeModeOf(userId, database),
  };
}

// ---------------------------------------------------------------------------
// saveProgress

async function save(
  userId: string,
  sessionId: string,
  batch: ReviewInput[],
  now: Date,
  database: Db,
): Promise<SavedProgress> {
  if (!Array.isArray(batch)) throw new Error("saveProgress: reviews must be a list");
  const result = await recordReviews(userId, sessionId, batch, database);
  const ids = [...new Set(batch.map((r) => r.cardId))];
  if (ids.length === 0) return { ...result, due: [] };

  const session = await loadSession(userId, sessionId, database);
  const exam = await loadExam(userId, session.examId, database);
  const states = await database
    .select({ cardId: cardStates.cardId, fsrs: cardStates.fsrs })
    .from(cardStates)
    .innerJoin(cards, eq(cards.id, cardStates.cardId))
    .where(and(inArray(cardStates.cardId, ids), eq(cards.userId, userId)));

  const due: SavedProgress["due"] = [];
  for (const s of states) {
    const fsrs = s.fsrs as MemoryState;
    const at = new Date(fsrs.lastReviewAt ?? now.getTime());
    const dueAt = new Date(aimed(fsrs, exam.at, at));
    await database.update(cardStates).set({ dueAt }).where(eq(cardStates.cardId, s.cardId));
    due.push({ cardId: s.cardId, dueAt });
  }
  due.sort((a, b) => ids.indexOf(a.cardId) - ids.indexOf(b.cardId));
  return { ...result, due };
}

// ---------------------------------------------------------------------------
// endSession

async function statsOf(session: Session, now: Date, database: Db): Promise<SessionStats> {
  const rows = await database
    .select({ cardId: reviews.cardId, grade: reviews.grade, firstTry: reviews.firstTry, at: reviews.at })
    .from(reviews)
    .where(and(eq(reviews.sessionId, session.id), eq(reviews.userId, session.userId)))
    .orderBy(asc(reviews.at), asc(reviews.id));
  let combo = 0;
  let best = 0;
  let firstOk = 0;
  let missed = 0;
  for (const r of rows) {
    if (r.grade === 1) missed++;
    if (r.firstTry && r.grade >= 3) {
      firstOk++;
      combo++;
      best = Math.max(best, combo);
    } else if (r.grade <= 2) combo = 0;
  }
  const unique = new Set(rows.map((r) => r.cardId)).size;
  const lastAt = rows.length ? rows[rows.length - 1].at.getTime() : (session.endedAt ?? now).getTime();
  return {
    cards: unique,
    reviews: rows.length,
    missed,
    seconds: Math.max(0, Math.floor((lastAt - session.startedAt.getTime()) / 1000)),
    best,
    perfect: rows.length > 0 && missed === 0 && firstOk >= unique - 1,
  };
}

function movesOf(state: ExamState, before: Readonly<Record<string, number>> | null): ConceptMove[] {
  if (!before) return [];
  return state.concepts
    .map((c) => {
      const from = typeof before[c.id] === "number" ? before[c.id] : c.mastery;
      return { id: c.id, name: c.name, from, to: c.mastery, rungFrom: rungOf(from), rungTo: c.rung };
    })
    .filter((m) => m.to - m.from > 0.004)
    .sort((a, b) => b.rungTo - b.rungFrom - (a.rungTo - a.rungFrom) || b.to - b.from - (a.to - a.from));
}

async function end(userId: string, sessionId: string, now: Date, database: Db): Promise<DoneScreen> {
  const session = await loadSession(userId, sessionId, database);
  const summary = (session.summary ?? {}) as Record<string, unknown>;
  const [stats, state] = await Promise.all([
    statsOf(session, now, database),
    examState(userId, session.examId, now, database),
  ]);
  const masteryBefore =
    summary.masteryBefore && typeof summary.masteryBefore === "object"
      ? (summary.masteryBefore as Record<string, number>)
      : null;
  const before = typeof summary.forecastBefore === "number" && masteryBefore ? summary.forecastBefore : state.forecast;
  const moved = movesOf(state, masteryBefore);
  await finishSession(
    userId,
    sessionId,
    {
      ...stats,
      forecastAfter: state.forecast,
      climbs: moved.map((m) => ({ concept: m.id, from: m.from, to: m.to })),
    },
    now,
    database,
  );
  // After the finish, so this session counts as done today.
  const [done, week] = await Promise.all([
    bitesDoneToday(userId, session.examId, now, database),
    studyWeek(userId, now, database, state.exam.at),
  ]);

  const plan = planFor(state, now, done);
  return {
    sessionId,
    examId: session.examId,
    mode: session.mode,
    stats,
    planEnd: plan.endShown,
    planLead: keepWords(plan.pace),
    forecastBefore: before,
    forecastAfter: state.forecast,
    forecastBeforeShown: Math.round(before),
    forecastAfterShown: Math.round(state.forecast),
    moved,
    week,
    bitesDoneToday: done,
    bitesPerDay: BITES_PER_DAY[state.exam.kind],
    anotherBite: todayBite(state, done) !== null,
  };
}

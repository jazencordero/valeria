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
 * - Days left are whole Helsinki calendar days to the exam (`daysBetween`),
 *   as the chart and the phase bar use them.
 * - Forecast: `forecastNow` (raw) and `forecastShown` (rounded). Plan end and
 *   verdict use the shown value, as the prototype does
 *   (`verdict(shown, target, planEnd(shown, daysLeft))`).
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
 *   the fixed goal of 4, plus the streak line.
 * - Cut: no offline queue. `saveProgress` is idempotent (the store skips
 *   reviews it already has), so the screen retries a failed save three times
 *   with the same batch, then tells her.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { currentUser } from "@/server/auth/session";
import { db, type Db } from "@/server/db/client";
import { cards, cardStates, CARD_TYPES, exams, reviews, SESSION_MODES, studySessions } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { daysBetween, startOfWeek } from "@/lib/dates";
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
  forecastNow,
  history,
  planEnd,
  verdict,
  type DailySnapshot,
  type Verdict,
} from "@/lib/study/forecast";
import {
  conceptMastery,
  focusConcept,
  phaseOf,
  phasePosition,
  rungName,
  rungOf,
  type Phase,
  type RungLevel,
} from "@/lib/study/ladder";
import { GRADES, grade as gradeMemory, intervalLabel, newCard, type Grade, type MemoryState } from "@/lib/study/memory";
import type { SessionMode } from "@/lib/study/session";
import { DEFAULT_GOAL, freeSkipsLeft, streakLine, weekOf, weeksInARow, type Week } from "@/lib/study/week";
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

export type ExamView = {
  exam: { id: string; title: string; kind: ExamKind; at: Date; targetPct: number; courseId: string };
  daysLeft: number;
  /** Forecast today, 0..100, not rounded (the chart draws this). */
  forecast: number;
  /** Forecast as screens show it, a whole percent. */
  forecastShown: number;
  /** Forecast on each day before today with data, oldest first, at most 13. */
  history: number[];
  /** Where a bite a day lands on exam day, in percent. */
  planEnd: number;
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
  gainEstimate: number;
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
  return end(user.id, String(sessionId), new Date(), db);
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
  concepts: ConceptView[];
  forecast: number;
};

const clampRung = (r: number) => Math.min(5, Math.max(1, Math.round(r))) as BiteCard["rung"];

function toBiteDeck(deck: Deck, examAt: Date, now: Date): BiteDeck {
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
    })),
    states,
    concepts: deck.concepts.map((c, i) => ({ id: c.id, weight: c.weight, order: i })),
    examAt,
    now,
  };
}

/** Each concept's mastery for the given card memories (missing = never graded). */
function masteries(deck: BiteDeck, states: Readonly<Record<string, MemoryState>>, examAt: Date): Record<string, number> {
  const out: Record<string, number> = {};
  for (const concept of deck.concepts) {
    const own = deck.cards
      .filter((c) => c.conceptId === concept.id)
      .map((c) => ({ state: states[c.id] ?? newCard(examAt), active: c.active }));
    out[concept.id] = conceptMastery(own, examAt);
  }
  return out;
}

function forecastOf(deck: Deck, mastery: Readonly<Record<string, number>>): number {
  return forecastNow(deck.concepts.map((c) => ({ weight: c.weight, mastery: mastery[c.id] ?? 0 })));
}

async function examState(userId: string, examId: string, now: Date, database: Db): Promise<ExamState> {
  const exam = await loadExam(userId, examId, database);
  const deck = await loadDeck(userId, examId, database);
  const biteDeck = toBiteDeck(deck, exam.at, now);
  const mastery = masteries(biteDeck, biteDeck.states, exam.at);
  const concepts = deck.concepts.map((c): ConceptView => {
    const m = mastery[c.id] ?? 0;
    const rung = rungOf(m);
    return { id: c.id, name: c.name, lecture: c.lecture, icon: c.icon, weight: c.weight, mastery: m, rung, rungName: rungName(rung) };
  });
  return { exam, deck, biteDeck, concepts, forecast: forecastOf(deck, mastery) };
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
  const examAt = state.exam.at;
  const memory: Record<string, MemoryState> = {};
  const out: DailySnapshot[] = [];
  let day: string | null = null;
  for (const r of rows) {
    const key = dayKey(r.at);
    if (key >= today) break;
    if (day !== null && key !== day) out.push({ day, mastery: masteries(state.biteDeck, memory, examAt) });
    day = key;
    memory[r.cardId] = gradeMemory(memory[r.cardId] ?? newCard(r.at), r.grade as Grade, r.at);
  }
  if (day !== null) {
    const last = { day, mastery: masteries(state.biteDeck, memory, examAt) };
    out.push(last);
    const yesterday = previousDay(today);
    if (day < yesterday) out.push({ day: yesterday, mastery: last.mastery });
  }
  return out;
}

async function studyWeek(userId: string, now: Date, database: Db): Promise<StudyWeek> {
  // Weeks in a row looks back week by week; a year of review days is plenty.
  const days = await reviewDays(userId, new Date(startOfWeek(now).getTime() - 53 * 7 * DAY_MS), database);
  const week = weekOf(days, DEFAULT_GOAL, now);
  const weeks = weeksInARow(days, DEFAULT_GOAL, now);
  const skips = freeSkipsLeft(days, DEFAULT_GOAL, now);
  return { ...week, weeksInARow: weeks, freeSkipsLeft: skips, streakLine: streakLine(weeks, skips) };
}

function todayBite(state: ExamState, done: number): Bite | null {
  return buildBite({ ...state.biteDeck, kind: state.exam.kind, bitesDoneToday: done });
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
    studyWeek(userId, now, database),
    gradeModeOf(userId, database),
    snapshots(userId, state, now, database),
  ]);
  const daysLeft = daysBetween(now, exam.at);
  const shown = Math.round(state.forecast);
  const end = planEnd(shown, daysLeft);
  const bite = todayBite(state, done);
  return {
    exam: { id: exam.id, title: exam.title, kind: exam.kind, at: exam.at, targetPct: exam.targetPct, courseId: exam.courseId },
    daysLeft,
    forecast: state.forecast,
    forecastShown: shown,
    history: history(snaps, state.deck.concepts.map((c) => ({ id: c.id, weight: c.weight }))),
    planEnd: end,
    verdict: verdict(shown, exam.targetPct, end),
    phase: phaseOf(daysLeft),
    phasePosition: phasePosition(daysLeft),
    concepts: state.concepts,
    focusConcept: focusConcept(state.concepts),
    bite: bite ? { ...bite, cards: sizeOf(bite) } : null,
    bitesDoneToday: done,
    bitesPerDay: BITES_PER_DAY[exam.kind],
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
  const { biteDeck } = state;

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
    gainEstimate: bite.gainEstimate,
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
    studyWeek(userId, now, database),
  ]);

  return {
    sessionId,
    examId: session.examId,
    mode: session.mode,
    stats,
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

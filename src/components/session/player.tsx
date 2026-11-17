"use client";

/**
 * The study session player (M3-43): runs the session reducer (M3-09) over the
 * frame (M3-31), the card stack (M3-37), the five card types (M3-32, M3-33,
 * M3-34, M3-35), the grade buttons or the feedback strip, the keys (M3-36) and
 * the card menu (M3-39); saves after every card and ends on the done screen
 * (M3-38).
 *
 *   <SessionPlayer sessionId={id} examId={examId} mode="bite" cards={cards}
 *     reviews={stored} … />
 *
 * Plain data in; the three server calls (`saveProgress`, `endSession` and
 * the card menu's `dropCard`) and the explain check are injectable, so tests
 * and previews run without a server.
 *
 * - Resume. The page hands over the session's cards and the reviews already
 *   stored for it. `resumeSession` replays them through the reducer, in the
 *   order they were graded, with the seed taken from the session id
 *   (`seedOf`), so a missed card goes back to the same place it went the
 *   first time and the queue after a reload is the queue she left: the card
 *   on screen is the first one not reviewed yet. Nothing comes from local
 *   storage; a card answered but not graded before the reload shows fresh.
 * - Saving. Every grade is kept in a pending list and sent with
 *   `saveProgress(sessionId, pending)` right away. A failed send is retried
 *   quietly with the same batch (`SAVE_RETRIES` times, `retryMs`, then twice
 *   that, then four times); the action skips reviews it already has, so a
 *   resend is harmless. Only when every retry failed does a quiet line show,
 *   and the pending reviews ride along with the next card (and a slow retry
 *   every `SLOW_RETRY_MS`). The end waits for the pending list to be empty.
 * - The end. After the last card the player waits for the saves, calls
 *   `endSession` and shows the done screen. "One more bite" goes to
 *   `/study/new?exam=<id>&kind=bite`; "Back to the exam" (and "Done for
 *   now", and Escape) to `/exams/<id>?from=<forecast before>`, so the exam
 *   page rolls its number up from the old forecast. Stop (the frame's
 *   confirm) saves what is pending and goes back the same way without ending
 *   the session, as the prototype's closeSession: a stopped bite is not a
 *   done bite, and opening it again resumes it.
 * - Return (M9-15). With `returnTo` (or `?return=<path>` in the URL, which
 *   GET /study/new adds), the done screen's back button, Escape and Stop go
 *   there instead of the exam page, and there is no "One more bite". A
 *   lecture page reads "Back to the lecture"; any other path "Back". Only a
 *   same-site path counts (`safeReturnPath`); anything else is ignored.
 * - Fix this card. A flagged or skipped card leaves the queue (every copy of
 *   it, a requeued miss included) and the next card shows; the last one
 *   leaving ends the session.
 * - Intervals under the grade buttons come from each card's memory (FSRS)
 *   aimed at the exam, as `beginSession` computes them, and the memory is
 *   graded here as well, so a missed card that comes back shows the new
 *   intervals. Counts at the top are the cards left: never graded (new), in
 *   (re)learning, in review (due).
 * - Section of a card comes from the page (see its header).
 *
 * - Ask about this card (M2-28 follow-up). With `tutor` (her account has the
 *   tutor switched on, read by the page on the server), a card that is answered
 *   or revealed (grade buttons or the feedback strip showing) gets "Ask about
 *   this card" beside the card menu: it opens the notes panel over the session
 *   on that card (`askAboutCard`, ./ask-card.ts). Before the answer the entry is
 *   not there, and when the card leaves the screen (next card, the end) the
 *   panel closes (`cardMovedOn`). Without `tutor` nothing of this renders.
 *
 * The whole screen is the frame (fixed, everything behind it inert), and the
 * done screen is the same kind of full-screen layer.
 *
 * - The stack. Cards sit on `SessionStage`: the card that was showing leaves
 *   as its grade says (1 sinks behind as a miss, 2 nudges down as hard, 3-4
 *   lift off as a pass; a dropped card lifts off too), with one or two edges
 *   behind for the cards left, and a boss card arriving asks the cap to cheer.
 *   Reduced motion cross-fades, and the test switch (?fast=1 or READY_FAST)
 *   moves at once; the stage reads both. While a card leaves it stays in the
 *   page for its exit, inert: only the card in place carries
 *   `data-testid="session-card"`, and a leaving card sends nothing.
 * - Match cards are M3-34's `CardMatch`, which keeps its own pairs and slips
 *   and reports once when the last pair is in. Its result is replayed into
 *   the reducer as `match` events (`matchEvents`: one wrong pair per slip,
 *   then each pair), so the grade (3 with no slips, else 2) and the feedback
 *   line come from the reducer as for every other card. Keys: terms and
 *   meanings are plain buttons (Tab, Enter or Space); `useSessionKeys` does
 *   nothing on a match card's front, and Enter on the feedback strip goes on.
 */
import { useIsPresent } from "motion/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { DoodleDefs } from "@/components/doodle";
import { Button } from "@/components/ui/button";
import { useInertOthers } from "@/lib/a11y/inert";
import { biteMinutes, type CardType, type SectionKind } from "@/lib/study/bite";
import type { McqOption, MatchPair, RubricPoint } from "@/lib/study/card-schema";
import { aimedDue } from "@/lib/study/exam-aim";
import { rungOf } from "@/lib/study/ladder";
import { GRADES, grade as gradeMemory, newCard, type Grade, type MemoryState } from "@/lib/study/memory";
import {
  currentCard,
  hint,
  initSession,
  step,
  type GradeMode,
  type SessionCard,
  type SessionEvent,
  type SessionMode,
  type SessionState,
} from "@/lib/study/session";
import type { Week } from "@/lib/study/week";
import type { DropKind, DropResult } from "@/app/(app)/study/card-actions";
import type { DoneScreen, SavedProgress } from "@/server/study/actions";
import type { ReviewInput } from "@/server/study/store";
import { CardBasic } from "./card-basic";
import { CardCloze } from "./card-cloze";
import { CardExplain, type CardExplainHandle, type ExplainCheck } from "./card-explain";
import { CardHead } from "./card-head";
import { CardMatch, MatchPrompt, matchSub, type MatchResult } from "./card-match";
import { CardMcq, PickPrompt } from "./card-mcq";
import { ASK_CARD_TEXT, askAboutCard, cardMovedOn, cardPassage } from "./ask-card";
import { CardMenu, DROP_TOAST_TEXT } from "./card-menu";
import { SessionDone } from "./done";
import { FeedbackStrip } from "./feedback-strip";
import { SessionFrame, type SessionCounts, type SessionFrameHandle } from "./frame";
import { GradeButtons } from "./grade-buttons";
import { SessionStage, type StageExit } from "./stage";
import { useSessionKeys } from "./use-session-keys";

// ---------------------------------------------------------------------------
// Copy

export const SAVE_FAILED_TEXT = "Not saved yet. It will keep trying.";
export const FINISHING_TEXT = "Saving your session…";
export const FINISH_FAILED_TEXT = "Could not finish the session. Check your connection.";
export const TRY_AGAIN = "Try again";
export const BACK_LABEL = "Back to the exam";
export const LECTURE_BACK_LABEL = "Back to the lecture";
export const RETURN_BACK_LABEL = "Back";

/** Retries after the first failed save. */
export const SAVE_RETRIES = 3;
export const RETRY_MS = 500;
export const SLOW_RETRY_MS = 15_000;
export const DROP_TOAST_MS = 2200;

// ---------------------------------------------------------------------------
// Data in

/** One card as the page hands it over. `body` is `cards.body` as stored. */
export type PlayerCard = {
  id: string;
  type: CardType;
  boss: boolean;
  section: SectionKind;
  conceptIds: string[];
  body: unknown;
  why: string | null;
  source: string | null;
  /** FSRS memory now; null when never graded. */
  memory: MemoryState | null;
};

/** A review already stored for this session. */
export type StoredReview = { cardId: string; grade: Grade; firstTry: boolean; ms: number | null; at: number };

export type SaveProgress = (sessionId: string, batch: ReviewInput[]) => Promise<SavedProgress>;
export type EndSession = (sessionId: string) => Promise<DoneScreen>;
export type DropAction = (cardId: string, kind: DropKind) => Promise<DropResult>;

export type SessionPlayerProps = {
  sessionId: string;
  examId: string;
  mode: SessionMode;
  /** Upper-cased on the done screen: "<SHORT> · FORECAST". */
  examShort: string;
  /** Exam time, epoch ms. */
  examAt: number;
  /** The exam's day as a sentence says it: "Friday" within six days, else "Mon 23 Nov". */
  examDay: string;
  targetPct: number;
  /** The grade she aims for, from her bundle (`exams.grade_target`); null when none is known. */
  targetGrade?: number | null;
  /** Session start, epoch ms. */
  startedAt: number;
  /** The session has ended already: go straight to the done screen. */
  ended?: boolean;
  /** The session's cards in their order. */
  cards: PlayerCard[];
  /** Concept names and mastery before the session, by id. */
  concepts: Readonly<Record<string, { name: string; mastery: number }>>;
  /** Reviews already stored for this session, in the order they were given. */
  reviews: StoredReview[];
  gradeMode: GradeMode;
  /** The forecast when the session began (shown percent), for `?from=`. */
  forecastBefore: number;
  /** She had reviewed something today before this session. */
  reviewedTodayBefore: boolean;
  saveProgress: SaveProgress;
  endSession: EndSession;
  dropCard?: DropAction;
  check?: ExplainCheck;
  /**
   * Where back goes instead of the exam page (a same-site path). Defaults to
   * the URL's `?return=`.
   */
  returnTo?: string | null;
  /** Base delay of the save retries (tests pass 0). */
  retryMs?: number;
  /** "Now" for intervals; tests pin it. */
  now?: () => number;
  /** Her account has the tutor switched on: "Ask about this card" once a card is answered. */
  tutor?: boolean;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)

/**
 * A path on this site, or null: starts with one "/" (never "//" or "/\",
 * which a browser reads as another host), no backslash, whitespace or control
 * character, at most 500 characters. Starting with "/" rules out a scheme.
 * The same rule as `safeReturn` in src/server/study/lecture-session.ts.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (/[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

const LECTURE_PATH = /^\/courses\/[^/?#]+\/lectures\/\d+(?:[?#].*)?$/;

/** The done screen's back label for a return path. */
export function returnLabel(path: string): string {
  return LECTURE_PATH.test(path) ? LECTURE_BACK_LABEL : RETURN_BACK_LABEL;
}

/** A stable 32-bit seed from the session id (FNV-1a), so a reload requeues the same way. */
export function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

function bodyOf(c: PlayerCard): Record<string, unknown> {
  return typeof c.body === "object" && c.body !== null ? (c.body as Record<string, unknown>) : {};
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function toSessionCard(c: PlayerCard): SessionCard {
  const pairs = c.type === "match" && Array.isArray(bodyOf(c).pairs) ? (bodyOf(c).pairs as unknown[]).length : undefined;
  return {
    id: c.id,
    type: c.type,
    boss: c.boss,
    section: c.section,
    conceptIds: c.conceptIds,
    ...(pairs ? { pairs } : {}),
  };
}

/**
 * The session as it stands after the stored reviews: each is replayed as a
 * grade, in order. A review of a card no longer in the session (flagged since)
 * is skipped; a review of a card that is in the queue but not first (should
 * not happen) is graded from where it is.
 */
export function resumeSession(input: {
  cards: readonly SessionCard[];
  mode: SessionMode;
  seed: number;
  startedAt: number;
  masteries: Readonly<Record<string, number>>;
  reviews: readonly StoredReview[];
  now: number;
}): SessionState {
  let s = initSession({ cards: input.cards, mode: input.mode, seed: input.seed, at: input.startedAt, masteries: input.masteries });
  for (const r of input.reviews) {
    if (s.over) break;
    const i = s.queue.indexOf(r.cardId);
    if (i < 0) continue;
    if (i > 0) s = { ...s, queue: [r.cardId, ...s.queue.filter((_, k) => k !== i)] };
    s = step({ ...s, phase: "graded", shownAt: r.at - (r.ms ?? 0) }, { type: "grade", g: r.grade, at: r.at });
  }
  return { ...s, shownAt: Math.max(input.now, s.lastAt) };
}

/** Removes every copy of a card from the queue; the next card shows (or the session ends). */
export function dropFromSession(s: SessionState, cardId: string, at: number): SessionState {
  const onScreen = s.queue[0] === cardId;
  const queue = s.queue.filter((id) => id !== cardId);
  if (queue.length === s.queue.length) return s;
  const over = queue.length === 0;
  const fresh = onScreen
    ? { revealed: 0, matched: [], slips: 0, picked: null, text: null, rubric: null, fbGrade: null, fbSlips: 0, shownAt: at }
    : {};
  return {
    ...s,
    ...fresh,
    queue,
    confirm: false,
    phase: over ? "done" : onScreen ? "front" : s.phase,
    over: over || s.over,
  };
}

/** Cards left by memory state: never graded, (re)learning, in review. */
export function countsOf(s: SessionState, memory: Readonly<Record<string, MemoryState | null>>): SessionCounts {
  const out = { new: 0, learning: 0, due: 0 };
  for (const id of new Set(s.over ? [] : s.queue)) {
    const m = memory[id];
    if (!m || m.state === 0) out.new++;
    else if (m.state === 2) out.due++;
    else out.learning++;
  }
  return out;
}

/** What each grade would schedule from `now`, aimed at the exam (as `beginSession`). */
export function intervalsOf(memory: MemoryState | null, examAt: number, now: number): Record<Grade, number> {
  const at = new Date(now);
  const base = memory ?? newCard(at);
  const out = {} as Record<Grade, number>;
  for (const g of GRADES) {
    const next = gradeMemory(base, g, at);
    out[g] = Math.max(0, (aimedDue(next, examAt, now) ?? next.dueAt) - now);
  }
  return out;
}

/**
 * A finished match card as reducer events: one wrong pair per slip, then
 * every pair right, so the reducer lands on the feedback strip with
 * `CardMatch`'s grade (3 with no slips, else 2) and its slips.
 */
export function matchEvents(result: Pick<MatchResult, "slips">, pairs: number, at: number): SessionEvent[] {
  const slips = Math.max(0, Math.floor(result.slips));
  const out: SessionEvent[] = [];
  for (let i = 0; i < slips; i++) out.push({ type: "match", a: "slip", b: "", at });
  for (let i = 0; i < Math.max(1, pairs); i++) out.push({ type: "match", a: String(i), b: String(i), at });
  return out;
}

/** How a graded card leaves the stack: 1 is a miss, 2 hard, 3 and 4 a pass. */
export function exitOf(g: Grade): StageExit {
  return g === 1 ? "miss" : g === 2 ? "hard" : "pass";
}

// ---------------------------------------------------------------------------
// Saving

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One send at a time; reviews added while a send runs go in the next one.
 * Resolves true once everything pending is stored, false after the retries.
 */
function useSaver(sessionId: string, save: SaveProgress, retryMs: number) {
  const pending = useRef<ReviewInput[]>([]);
  const running = useRef<Promise<boolean> | null>(null);
  const [failing, setFailing] = useState(false);
  const latest = useRef({ save, retryMs });
  useEffect(() => {
    latest.current = { save, retryMs };
  });

  const run = useCallback(async (): Promise<boolean> => {
    while (pending.current.length) {
      const batch = pending.current.slice();
      let ok = false;
      for (let attempt = 0; attempt <= SAVE_RETRIES; attempt++) {
        try {
          await latest.current.save(sessionId, batch);
          ok = true;
          break;
        } catch {
          if (attempt < SAVE_RETRIES) await sleep(latest.current.retryMs * 2 ** attempt);
        }
      }
      if (!ok) {
        setFailing(true);
        return false;
      }
      pending.current = pending.current.filter((r) => !batch.includes(r));
      setFailing(false);
    }
    return true;
  }, [sessionId]);

  const flush = useCallback((): Promise<boolean> => {
    if (running.current) return running.current;
    // The loop picks up reviews pushed while a send is on its way; `finally`
    // runs in the same microtask turn, so no push can slip in between.
    const p: Promise<boolean> = run().finally(() => {
      running.current = null;
    });
    running.current = p;
    return p;
  }, [run]);

  const push = useCallback(
    (r: ReviewInput) => {
      pending.current.push(r);
      return flush();
    },
    [flush],
  );

  // While failing, try again now and then without her doing anything.
  useEffect(() => {
    if (!failing) return;
    const t = setInterval(() => void flush(), SLOW_RETRY_MS);
    return () => clearInterval(t);
  }, [failing, flush]);

  return { push, flush, failing };
}

// ---------------------------------------------------------------------------
// The player

type View =
  | { kind: "play" }
  | { kind: "finishing"; failed: boolean }
  | { kind: "done"; data: DoneScreen };

export function SessionPlayer(props: SessionPlayerProps) {
  const {
    sessionId,
    examId,
    mode,
    cards,
    concepts,
    gradeMode,
    examAt,
    saveProgress,
    endSession,
    dropCard,
    check,
    retryMs = RETRY_MS,
  } = props;
  const router = useRouter();
  const search = useSearchParams();
  const returnTo = safeReturnPath(props.returnTo !== undefined ? props.returnTo : search?.get("return"));
  const now = props.now ?? Date.now;

  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const [s, setS] = useState<SessionState>(() =>
    resumeSession({
      cards: cards.map(toSessionCard),
      mode,
      seed: seedOf(sessionId),
      startedAt: props.startedAt,
      masteries: Object.fromEntries(Object.entries(concepts).map(([id, c]) => [id, c.mastery])),
      reviews: props.reviews,
      now: now(),
    }),
  );
  const sRef = useRef(s);
  const [memory, setMemory] = useState<Record<string, MemoryState | null>>(() =>
    Object.fromEntries(cards.map((c) => [c.id, c.memory])),
  );
  const [view, setView] = useState<View>(() =>
    props.ended || s.over ? { kind: "finishing", failed: false } : { kind: "play" },
  );
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const [dropToast, setDropToast] = useState(0);
  const [exit, setExit] = useState<StageExit>("pass");
  const frame = useRef<SessionFrameHandle>(null);
  const explainRef = useRef<CardExplainHandle>(null);
  const saver = useSaver(sessionId, saveProgress, retryMs);
  const backHref = (from: number) => returnTo ?? `/exams/${examId}?from=${Math.round(from)}`;

  // The end: wait for the saves, then the done screen.
  const finishing = useRef(false);
  const finish = useCallback(async () => {
    if (finishing.current) return;
    finishing.current = true;
    setView({ kind: "finishing", failed: false });
    let data: DoneScreen | null = null;
    if (await saver.flush()) {
      for (let attempt = 0; attempt <= SAVE_RETRIES && !data; attempt++) {
        try {
          data = await endSession(sessionId);
        } catch {
          if (attempt < SAVE_RETRIES) await sleep(retryMs * 2 ** attempt);
        }
      }
    }
    finishing.current = false;
    setView(data ? { kind: "done", data } : { kind: "finishing", failed: true });
  }, [saver, endSession, sessionId, retryMs]);

  // A session that was already over when the page loaded.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (view.kind === "finishing") void finish();
  }, [view.kind, finish]);

  const send = useCallback(
    (e: SessionEvent) => {
      const prev = sRef.current;
      const next = step(prev, e);
      if (next === prev) return;
      sRef.current = next;
      setS(next);

      if (next.reviews.length > prev.reviews.length) {
        const r = next.reviews[next.reviews.length - 1];
        const at = next.lastAt;
        void saver.push({ ...r, at });
        setExit(exitOf(r.grade));
        setMemory((m) => ({ ...m, [r.cardId]: gradeMemory(m[r.cardId] ?? newCard(new Date(at)), r.grade, new Date(at)) }));
        const f = frame.current;
        if (r.grade === 1) {
          f?.miss();
          f?.react("wince");
        } else {
          const climbed = next.lastClimbs[0];
          if (climbed) f?.climb(concepts[climbed]?.name ?? climbed, rungOf(next.mastery[climbed] ?? 0));
          if (r.firstTry && r.grade >= 3) f?.react("nod");
        }
        // A boss arriving cheers through the stage's onBossEnter.
      }
      if (next.over && !prev.over && !next.stopped) void finish();
    },
    [saver, concepts, finish],
  );

  const stop = useCallback(async () => {
    send({ type: "stop", at: now() });
    await saver.flush();
    router.push(backHref(props.forecastBefore));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, saver, router, props.forecastBefore, returnTo]);

  const onDrop = useCallback((cardId: string) => {
    const prev = sRef.current;
    const next = dropFromSession(prev, cardId, now());
    if (next === prev) return;
    sRef.current = next;
    setS(next);
    setExit("pass");
    setDropToast((n) => n + 1);
    if (next.over && !prev.over) void finish();
  }, [finish, now]);

  useEffect(() => {
    if (!dropToast) return;
    const t = setTimeout(() => setDropToast(0), DROP_TOAST_MS);
    return () => clearTimeout(t);
  }, [dropToast]);

  const card = currentCard(s);
  const pc = card ? byId.get(card.id) : undefined;
  // Changes when the card on screen changes, is graded, or is back on its front (a miss that returns).
  const shownKey =
    view.kind === "play" && card ? `${card.id}:${s.passed}:${s.reviews.length}:${s.phase === "front" ? "front" : "shown"}` : "none";

  // A notes panel opened for a card closes when that card leaves the screen or starts over.
  useEffect(() => () => cardMovedOn(), [shownKey]);

  useSessionKeys(
    { phase: view.kind === "play" ? s.phase : "done", cardType: card?.type, gradeMode },
    {
      onGrade: (g) => send({ type: "grade", g, at: now() }),
      onContinue: () => send({ type: "continue", at: now() }),
      onCheck: () => explainRef.current?.check(),
    },
  );

  if (view.kind === "done") {
    return (
      <DoneLayer
        data={view.data}
        props={props}
        returnTo={returnTo}
        onMore={() => router.push(`/study/new?exam=${examId}&kind=bite`)}
        onBack={() => router.push(backHref(view.data.forecastBeforeShown))}
      />
    );
  }

  const run = [...s.order, ...(s.over ? [] : s.queue)];
  const names = (ids: readonly string[]) => ids.map((id) => concepts[id]?.name ?? "");
  const primary = card ? card.conceptIds[0] : undefined;
  const rung = primary ? rungOf(s.mastery[primary] ?? 0) : 0;
  const cardKey = card ? `${card.id}:${s.passed}` : "none";

  let actions: ReactNode = null;
  if (view.kind === "play" && card && pc) {
    if (s.phase === "graded") {
      const ivl = intervalsOf(memory[card.id] ?? null, examAt, now());
      actions = (
        <GradeButtons
          key={cardKey}
          mode={gradeMode}
          next={ivl}
          onGrade={(g) => send({ type: "grade", g, at: now() })}
        />
      );
    } else if (s.phase === "fb" && s.fbGrade) {
      actions = (
        <FeedbackStrip
          key={cardKey}
          grade={s.fbGrade as 1 | 2 | 3}
          concept={names(card.conceptIds)[0] ?? ""}
          passed={s.passed}
          boss={card.boss}
          sub={card.type === "match" ? matchSub(s.fbSlips) : undefined}
          keys={false}
          onContinue={() => send({ type: "continue", at: now() })}
        />
      );
    } else if (card.type === "mcq") {
      actions = <PickPrompt />;
    } else if (card.type === "match") {
      actions = <MatchPrompt />;
    }
  }

  return (
    <>
      <DoodleDefs />
      <SessionFrame
        ref={frame}
        cards={run.map((id) => ({ section: s.cards[id]?.section ?? "learn" }))}
        index={s.passed}
        counts={countsOf(s, memory)}
        startedAt={props.startedAt}
        streak={s.combo}
        hint={view.kind === "play" ? hint(s, gradeMode) : undefined}
        onStop={() => void stop()}
        actions={<div ref={setFooter}>{actions}</div>}
      >
        {saver.failing && view.kind === "play" ? (
          <p className="mb-2 text-center text-[13px] text-ink-3" role="status" data-testid="save-failed">
            {SAVE_FAILED_TEXT}
          </p>
        ) : null}
        {dropToast ? (
          <p
            role="status"
            data-testid="drop-toast"
            className="mx-auto mb-2 w-fit rounded-full bg-[var(--btn)] px-3 py-1.5 text-[13px] text-[var(--btn-ink)] shadow-[var(--shadow-card)]"
          >
            {DROP_TOAST_TEXT}
          </p>
        ) : null}
        {view.kind === "finishing" ? (
          <Finishing failed={view.failed} onRetry={() => void finish()} />
        ) : card && pc ? (
          <>
            <SessionStage
              className="mt-10"
              cardKey={cardKey}
              after={Math.max(0, s.queue.length - 1)}
              exit={exit}
              boss={card.boss}
              onBossEnter={() => frame.current?.react("cheer")}
            >
              <StagedCard
                pc={pc}
                section={card.section}
                conceptNames={names(card.conceptIds)}
                rung={rung}
                actionsEl={footer}
                explainRef={explainRef}
                check={check}
                send={send}
                now={now}
                sessionId={props.sessionId}
              />
            </SessionStage>
            <div className="mt-2 flex items-center justify-end gap-2">
              {props.tutor && view.kind === "play" && (s.phase === "graded" || s.phase === "fb") ? (
                <Button
                  variant="text"
                  size="sm"
                  className="mr-auto"
                  data-testid="ask-card"
                  onClick={() => askAboutCard(pc.id, cardPassage(pc.type, pc.body))}
                >
                  {ASK_CARD_TEXT}
                </Button>
              ) : null}
              <CardMenu key={cardKey} cardId={card.id} action={dropCard} onDrop={onDrop} />
            </div>
          </>
        ) : null}
      </SessionFrame>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces

function Finishing({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return (
    <div className="mt-16 grid justify-items-center gap-3 text-center" data-testid="finishing">
      <p className="text-[15px] text-ink-2" role="status">
        {failed ? FINISH_FAILED_TEXT : FINISHING_TEXT}
      </p>
      {failed ? (
        <Button variant="secondary" onClick={onRetry}>
          {TRY_AGAIN}
        </Button>
      ) : null}
    </div>
  );
}

type CardBodyProps = {
  pc: PlayerCard;
  section: SectionKind;
  conceptNames: string[];
  rung: number;
  actionsEl: Element | null;
  explainRef: RefObject<CardExplainHandle | null>;
  check?: ExplainCheck;
  send: (e: SessionEvent) => void;
  now: () => number;
  /** The session's id: with the card's id it seeds the order a card's options are shown in. */
  sessionId: string;
};

/**
 * The card on the stage. Once it starts leaving (the stage keeps it for its
 * exit) it drops the test id, stops portalling into the footer and sends
 * nothing, so only the card in place is played.
 */
function StagedCard(props: CardBodyProps) {
  const present = useIsPresent();
  const { pc, send } = props;
  const live = useRef(present);
  useEffect(() => {
    live.current = present;
  }, [present]);
  const guarded = useCallback((e: SessionEvent) => {
    if (live.current) send(e);
  }, [send]);
  return (
    <div
      data-testid={present ? "session-card" : undefined}
      data-card-id={pc.id}
      data-card-type={pc.type}
    >
      <CardBody {...props} actionsEl={present ? props.actionsEl : null} send={guarded} />
    </div>
  );
}

function CardBody({
  pc,
  section,
  conceptNames,
  rung,
  actionsEl,
  explainRef,
  check,
  send,
  now,
  sessionId,
}: CardBodyProps) {
  const b = bodyOf(pc);
  const common = { section, conceptNames, rung, actionsEl, autoFocus: true };
  const source = pc.source ?? "";
  const why = pc.why ?? undefined;
  const head = <CardHead section={section} conceptNames={conceptNames} rung={rung} />;

  switch (pc.type) {
    case "basic":
      return (
        <CardBasic
          {...common}
          card={{ q: str(b.q), a: str(b.a), source, why }}
          onRevealed={() => send({ type: "reveal", at: now() })}
        />
      );
    case "cloze":
      return (
        <CardCloze
          {...common}
          card={{ q: str(b.q), source, why }}
          onRevealed={() => send({ type: "reveal", at: now() })}
        />
      );
    case "mcq":
      return (
        <CardMcq
          card={{ q: str(b.q), opts: Array.isArray(b.opts) ? (b.opts as McqOption[]) : [], source, why }}
          head={head}
          seed={`${pc.id}:${sessionId}`}
          onResult={(r) => send({ type: "pick", option: r.picked, correct: r.correct, at: now() })}
        />
      );
    case "explain":
      return (
        <CardExplain
          {...common}
          ref={explainRef}
          cardId={pc.id}
          card={{
            q: str(b.q),
            rubric: Array.isArray(b.rubric) ? (b.rubric as RubricPoint[]) : [],
            model: str(b.model),
            source,
            why,
          }}
          check={check}
          onChecked={(o) => send({ type: "check", text: o.text, rubricResult: o.rubric, at: now() })}
          onRevealed={() => {}}
        />
      );
    case "match": {
      const pairs = Array.isArray(b.pairs) ? (b.pairs as MatchPair[]) : [];
      return (
        <CardMatch
          card={{ q: str(b.q), pairs, order: Array.isArray(b.order) ? (b.order as number[]) : [] }}
          head={head}
          onResult={(r) => {
            for (const e of matchEvents(r, pairs.length, now())) send(e);
          }}
        />
      );
    }
  }
}

function DoneLayer({
  data,
  props,
  returnTo,
  onMore,
  onBack,
}: {
  data: DoneScreen;
  props: SessionPlayerProps;
  returnTo: string | null;
  onMore: () => void;
  onBack: () => void;
}) {
  const ref = useInertOthers<HTMLElement>(true);
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      latest.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const names: Record<string, { name: string }> = {};
  for (const [id, c] of Object.entries(props.concepts)) names[id] = { name: c.name };
  for (const m of data.moved) names[m.id] = { name: m.name };
  const week: Week = {
    days: data.week.days,
    count: data.week.count,
    goal: data.week.goal,
    met: data.week.met,
    sentence: data.week.sentence,
  };
  const dayNew = !props.reviewedTodayBefore && data.stats.reviews > 0;
  const goalNew = dayNew && data.week.met && data.week.count === data.week.goal;

  return (
    <section
      ref={ref}
      aria-label="Session done"
      data-testid="session-done"
      className="fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-paper text-ink"
    >
      <DoodleDefs />
      <div className="mx-auto w-full max-w-[560px] px-[var(--pad)] pt-[max(24px,env(safe-area-inset-top,0px))] pb-[max(24px,env(safe-area-inset-bottom,0px))]">
        <SessionDone
          result={{
            cards: data.stats.cards,
            seconds: data.stats.seconds,
            best: data.stats.best,
            perfect: data.stats.perfect,
            climbs: data.moved.map((m) => ({ concept: m.id, from: m.from, to: m.to })),
            reviews: [],
          }}
          mode={data.mode}
          examShort={props.examShort}
          forecastBefore={data.forecastBeforeShown}
          forecastAfter={data.forecastAfterShown}
          target={props.targetPct}
          targetGrade={props.targetGrade ?? null}
          planEnd={data.planEnd}
          planLead={data.planLead}
          examDay={props.examDay}
          concepts={names}
          week={week}
          weeksInARow={data.week.weeksInARow}
          freeSkipsLeft={data.week.freeSkipsLeft}
          dayNew={dayNew}
          goalNew={goalNew}
          nextBiteMinutes={data.anotherBite && !returnTo ? biteMinutes(props.cards.length) : null}
          backLabel={returnTo ? returnLabel(returnTo) : BACK_LABEL}
          onMore={onMore}
          onBack={onBack}
        />
      </div>
    </section>
  );
}

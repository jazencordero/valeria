/**
 * A study session (M3-43): `/study/<sessionId>`, started by GET /study/new.
 * This page reads the session from the database and hands plain data to the
 * client `SessionPlayer`, which covers the whole screen (the shell stays
 * mounted behind it, inert).
 *
 * Everything depends on the cookie, the id and the clock, so it streams
 * inside Suspense (cacheComponents). An unknown or malformed id, or someone
 * else's session, is a 404.
 *
 * What it reads, and why:
 * - The session row: mode, exam, start, end, and `summary` (`cardIds` from
 *   `startSession`, `masteryBefore` and `forecastBefore` from
 *   `beginSession`).
 * - The exam's deck (`loadDeck`): each card's body, why, source, concepts and
 *   memory now. Only active cards come back, so a card she flagged or skipped
 *   since stays out after a reload.
 * - The session's stored reviews, in the order she gave them: the player
 *   replays them to land on the first card she has not reviewed yet. This is
 *   the resume: server state only, nothing from local storage.
 * - Sections are not stored with the session, so they are rebuilt from the
 *   rules in `src/lib/study/bite.ts`: a boss card is in boss; a tile session
 *   is all learn, an extra session all warm; in a bite the leading run (at
 *   most 4) of non-boss cards she had graded before the session started is
 *   the warm-up, the rest learn. Only boss matters to the rules (the requeue
 *   keeps the boss last); warm and learn only colour the head and progress.
 * - Whether her account has the tutor switched on (`tutorEnabled`, as the
 *   app layout decides it for the notes panel): the player then offers "Ask
 *   about this card" once a card is answered (M2-28 follow-up).
 * - Whether she had reviewed anything earlier today (the done screen pops
 *   today's dot only for the first session of the day).
 */
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { SessionPlayer, type PlayerCard, type StoredReview } from "@/components/session/player";
import { byDay } from "@/lib/dates";
import type { SectionKind } from "@/lib/study/bite";
import type { Grade } from "@/lib/study/memory";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { shortNameOf } from "@/server/data/courses";
import { targetGradeOf } from "@/server/data/exams";
import { db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { exams, reviews, studySessions } from "@/server/db/schema/study";
import { dropCard } from "@/app/(app)/study/card-actions";
import { endSession, saveProgress } from "@/server/study/actions";
import { dayKey, loadDeck, StudyNotFound, type DeckCard } from "@/server/study/store";
import { tutorEnabled } from "@/server/tutor/context";

type Params = Promise<{ sessionId: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WARM_MAX = 4;


async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

function sectionsOf(
  mode: string,
  list: readonly DeckCard[],
  gradedBefore: ReadonlySet<string>,
): Map<string, SectionKind> {
  const out = new Map<string, SectionKind>();
  let warmRun = mode === "bite";
  let warm = 0;
  for (const c of list) {
    let s: SectionKind;
    if (c.boss && mode !== "tile" && mode !== "extra") s = "boss";
    else if (mode === "extra") s = "warm";
    else if (mode === "bite" && warmRun && warm < WARM_MAX && gradedBefore.has(c.id)) {
      s = "warm";
      warm++;
    } else s = "learn";
    if (s !== "warm") warmRun = false;
    out.set(c.id, s);
  }
  return out;
}

async function Session({ params }: { params: Params }) {
  const { sessionId } = await params;
  await connection();
  if (!UUID.test(sessionId)) notFound();
  const user = await signedInUser();

  const [session] = await db
    .select()
    .from(studySessions)
    .where(and(eq(studySessions.id, sessionId), eq(studySessions.userId, user.id)));
  if (!session) notFound();
  const [exam] = await db
    .select({ id: exams.id, title: exams.title, at: exams.at, targetPct: exams.targetPct, gradeTarget: exams.gradeTarget, courseId: exams.courseId })
    .from(exams)
    .where(and(eq(exams.id, session.examId), eq(exams.userId, user.id)));
  if (!exam) notFound();

  let deck;
  try {
    deck = await loadDeck(user.id, exam.id);
  } catch (err) {
    if (err instanceof StudyNotFound) notFound();
    throw err;
  }

  const summary = (session.summary ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(summary.cardIds) ? summary.cardIds.filter((v): v is string => typeof v === "string") : [];
  const byId = new Map(deck.cards.map((c) => [c.id, c]));
  const list = ids.map((id) => byId.get(id)).filter((c): c is DeckCard => c !== undefined);

  const [course] = await db
    .select({ name: courses.name })
    .from(courses)
    .where(and(eq(courses.id, exam.courseId), eq(courses.userId, user.id)));

  const [stored, before, [lastBefore]] = await Promise.all([
    db
      .select({ cardId: reviews.cardId, grade: reviews.grade, firstTry: reviews.firstTry, ms: reviews.ms, at: reviews.at })
      .from(reviews)
      .where(and(eq(reviews.sessionId, session.id), eq(reviews.userId, user.id)))
      .orderBy(asc(reviews.at), asc(reviews.id)),
    list.length
      ? db
          .selectDistinct({ cardId: reviews.cardId })
          .from(reviews)
          .where(
            and(
              eq(reviews.userId, user.id),
              inArray(
                reviews.cardId,
                list.map((c) => c.id),
              ),
              lt(reviews.at, session.startedAt),
            ),
          )
      : Promise.resolve([] as { cardId: string }[]),
    db
      .select({ at: reviews.at })
      .from(reviews)
      .where(and(eq(reviews.userId, user.id), lt(reviews.at, session.startedAt)))
      .orderBy(desc(reviews.at))
      .limit(1),
  ]);

  const sections = sectionsOf(session.mode, list, new Set(before.map((r) => r.cardId)));
  const cards: PlayerCard[] = list.map((c) => ({
    id: c.id,
    type: c.type,
    boss: c.boss,
    section: sections.get(c.id) ?? "learn",
    conceptIds: c.conceptIds,
    body: c.body,
    why: c.why,
    source: c.source,
    memory: c.memory?.fsrs ?? null,
  }));

  const masteryBefore =
    summary.masteryBefore && typeof summary.masteryBefore === "object"
      ? (summary.masteryBefore as Record<string, unknown>)
      : {};
  const concepts = Object.fromEntries(
    deck.concepts.map((c) => [c.id, { name: c.name, mastery: typeof masteryBefore[c.id] === "number" ? (masteryBefore[c.id] as number) : 0 }]),
  );
  const forecastBefore = typeof summary.forecastBefore === "number" ? Math.round(summary.forecastBefore) : 0;
  const reviewedTodayBefore = lastBefore !== undefined && dayKey(lastBefore.at) === dayKey(new Date());
  const gradeMode = user.settings?.gradeMode === "anki" ? "four" : "two";

  return (
    <SessionPlayer
      sessionId={session.id}
      examId={exam.id}
      mode={session.mode}
      examShort={course ? shortNameOf(course.name) : exam.title}
      examAt={exam.at.getTime()}
      examDay={byDay(exam.at, new Date())}
      targetPct={exam.targetPct}
      targetGrade={targetGradeOf(exam.gradeTarget)}
      startedAt={session.startedAt.getTime()}
      ended={session.endedAt !== null}
      cards={cards}
      concepts={concepts}
      reviews={stored.map(
        (r): StoredReview => ({ cardId: r.cardId, grade: r.grade as Grade, firstTry: r.firstTry, ms: r.ms, at: r.at.getTime() }),
      )}
      gradeMode={gradeMode}
      forecastBefore={forecastBefore}
      reviewedTodayBefore={reviewedTodayBefore}
      saveProgress={saveProgress}
      endSession={endSession}
      dropCard={dropCard}
      tutor={tutorEnabled(user.settings)}
    />
  );
}

export default function StudySessionPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={null}>
      <Session params={params} />
    </Suspense>
  );
}

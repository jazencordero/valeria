/**
 * One exam (M3-42): the header and the tabs Today, Progress, Lectures,
 * Practise, Notes (M9-23: `getExamTabs` reads the last two's lectures and
 * notes). The
 * client part is `ExamPage`; this page reads her data and turns M3-18's
 * `examView` into what the page shows. An unknown id, a malformed one,
 * another user's exam or an exam of a course she has hidden is a 404.
 *
 * Everything here depends on the cookie, the id and the clock, so it streams
 * inside Suspense (cacheComponents).
 *
 * Choices:
 * - An exam whose clock time is a placeholder (`exams.time_is_placeholder`) is a whole-day exam:
 *   the header names its day with no time. "Exam day" lasts all of that Helsinki day for every
 *   exam (`examView`'s `daysLeft` counts calendar days).
 * - From 00:00 the day after, the exam is over: the header and the Today tab say "This exam is
 *   over.", the Progress tab says it in place of the plan sentence, `examView` builds no bite,
 *   and the sheet leaves the phase strip out. Practise, Lectures and Notes stay as they are.
 * - Before the study start (`exams.start_new_on` still ahead, M3-53) the page says one thing:
 *   "Starts Tue 24 Nov. Nothing to do here until then." in place of the verdict, the done plan
 *   and the plan sentence. A bite `examView` still builds (cards she has already graded) shows.
 * - Today. An exam with cards shows the bite block: today's bite, or the done
 *   state when `examView` has none. With no cards it shows, in this order:
 *   the AI question while the course's study rule (`courses.ai_study`) is not
 *   a yes; "Making your cards" while a concepts job is live (the same check
 *   as the Exams tab, `getExamsView`); else one plain line.
 * - The AI question is asked only while there are no cards: cards that exist
 *   (the demo's, an imported deck's) are hers to study whatever the answer.
 * - "mostly <concept>" is the concept most of the bite's cards belong to (a
 *   card's first linked concept, as in `examView`).
 * - "Then: bite 2 of 2, N min" uses this bite's minutes: the next bite is
 *   built by the same rule only once this one is done.
 * - Tiles count the active, non-boss cards of each type (what a tile session
 *   draws from). "Practise this" minutes are for the first four cards that
 *   touch the concept (`conceptSession`).
 * - `?from=<pct>` (back from a session) is the old forecast the header chip
 *   and the big percent roll from.
 *
 * `setStudyRule` below is this page's one Server Action: her answer to the AI
 * question. It reads who she is from the cookie and finds the course through
 * her own exam, so the browser only ever names an exam id and an answer.
 */
import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";
import { CONCEPT_ICON_NAMES, type ConceptIconName } from "@/components/exams/concept-icons";
import { ExamPage, type ExamPageToday, type StudyRuleResult } from "@/components/exams/exam-page";
import type { HeatDay } from "@/components/study/heatmap";
import type { ReviewDay } from "@/components/study/next-reviews";
import type { PracticeType } from "@/components/study/practice-tiles";
import type { ProgressConcept } from "@/components/study/progress-sheet";
import { byDay, startsLine, TIME_ZONE } from "@/lib/dates";
import { biteMinutes } from "@/lib/study/bite";
import { gradeFor } from "@/lib/study/forecast";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { shortNameOf } from "@/server/data/courses";
import { getExamTabs } from "@/server/data/exam-tabs";
import { getExamsView, startsOn, targetGradeOf } from "@/server/data/exams";
import { db } from "@/server/db/client";
import { AI_STUDY, courses } from "@/server/db/schema/courses";
import { exams } from "@/server/db/schema/study";
import { examView, setGradeMode, type ExamView } from "@/server/study/actions";
import { queueConcepts } from "@/server/study/exams";
import { dayKey, loadDeck, StudyNotFound, type DayCount, type Deck } from "@/server/study/store";
import { loadExamDocuments } from "./documents/[slug]/page";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Her answer to "Does <course> allow AI tools on its material?"

const RuleInput = z.object({ examId: z.uuid(), rule: z.enum(AI_STUDY) });

async function setStudyRule(examId: unknown, rule: unknown): Promise<StudyRuleResult> {
  "use server";
  const parsed = RuleInput.safeParse({ examId, rule });
  if (!parsed.success) return { ok: false, reason: "invalid" };

  let userId: string;
  try {
    userId = (await currentUser()).id;
  } catch (err) {
    if (err instanceof NotSignedIn) return { ok: false, reason: "signed_out" };
    throw err;
  }

  const [exam] = await db
    .select({ id: exams.id, userId: exams.userId, courseId: exams.courseId })
    .from(exams)
    .where(and(eq(exams.id, parsed.data.examId), eq(exams.userId, userId)));
  if (!exam) return { ok: false, reason: "not_found" };

  const [row] = await db
    .update(courses)
    .set({ aiStudy: parsed.data.rule })
    .where(and(eq(courses.id, exam.courseId), eq(courses.userId, userId)))
    .returning({ aiStudy: courses.aiStudy });
  if (!row) return { ok: false, reason: "not_found" };

  // A yes is what the concepts job waits for (it ends without an AI call until then), so it is
  // queued again: at most one live job per exam, and none when the course has no lecture text.
  if (row.aiStudy === "allowed") await queueConcepts(exam);

  // The page reads the rule on the server; re-render it with the new value.
  refresh();
  return { ok: true, rule: row.aiStudy };
}

// ---------------------------------------------------------------------------
// Words for days. Day keys are Helsinki calendar days, `YYYY-MM-DD`.

const DAY_MS = 24 * 60 * 60 * 1000;
const keyTime = (key: string) => Date.parse(`${key}T12:00:00Z`);
const keyDays = (from: string, to: string) => Math.round((keyTime(to) - keyTime(from)) / DAY_MS);
const addDays = (key: string, days: number) => new Date(keyTime(key) + days * DAY_MS).toISOString().slice(0, 10);

const keyParts = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

function partsOf(key: string): { weekday: string; day: string; month: string } {
  const out = { weekday: "", day: "", month: "" };
  for (const p of keyParts.formatToParts(keyTime(key))) {
    if (p.type === "weekday" || p.type === "day" || p.type === "month") out[p.type] = p.value;
  }
  return out;
}

/** "Tue 17". */
function shortDay(key: string): string {
  const { weekday, day } = partsOf(key);
  return `${weekday} ${day}`;
}

/** "Tue 10 Nov". */
function longDay(key: string): string {
  const { weekday, day, month } = partsOf(key);
  return `${weekday} ${day} ${month}`;
}

/** "Today", "Tomorrow", "Tue 17". */
function reviewDay(key: string, today: string): string {
  const d = keyDays(today, key);
  return d <= 0 ? "Today" : d === 1 ? "Tomorrow" : shortDay(key);
}

const clockOf = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** What a past exam's page says in place of the verdict, today's plan and the plan sentence. */
const OVER = "This exam is over.";

/** How many following review days the Practise tab lists after today. */
const REVIEW_DAYS = 3;

/** "Today 6 · Tomorrow 4 · Tue 17 3": today first, then the next days with cards. */
function reviewDays(next: readonly DayCount[], today: string): ReviewDay[] {
  const todayCount = next.filter((d) => d.day <= today).reduce((n, d) => n + d.count, 0);
  const later = next.filter((d) => d.day > today && d.count > 0).slice(0, REVIEW_DAYS);
  return [{ label: "Today", count: todayCount }, ...later.map((d) => ({ label: reviewDay(d.day, today), count: d.count }))];
}

/** The done state's sentence: when cards next come back. */
function nextReviewsLine(next: readonly DayCount[], today: string): string {
  const first = next.find((d) => d.day > today && d.count > 0);
  if (first) return `Next reviews ${reviewDay(first.day, today).replace("Tomorrow", "tomorrow")}.`;
  return next.some((d) => d.count > 0) ? "Next reviews later today." : "Nothing scheduled yet.";
}

/** What comes after this phase: Strengthen from 10 days out, Final review from 3. */
function phaseNext(daysLeft: number, examDay: string): string | undefined {
  if (daysLeft > 10) return `Strengthen starts ${shortDay(addDays(examDay, -10))}.`;
  if (daysLeft >= 4) return `Final review starts ${shortDay(addDays(examDay, -3))}.`;
  return undefined;
}

// ---------------------------------------------------------------------------
// From the deck

function tileCounts(deck: Deck): Record<PracticeType, number> {
  // The four tile types, written out: the tiles' own list lives in a client module.
  const counts: Record<PracticeType, number> = { basic: 0, cloze: 0, explain: 0, mcq: 0 };
  for (const c of deck.cards) {
    if (c.boss) continue;
    if (c.type === "basic" || c.type === "cloze" || c.type === "explain" || c.type === "mcq") counts[c.type] += 1;
  }
  return counts;
}

/** The concept most of the bite's cards belong to; ties go to the earlier concept. */
function biteFocus(view: ExamView, deck: Deck): string {
  const conceptOf = new Map(deck.cards.map((c) => [c.id, c.conceptIds[0]]));
  const per = new Map<string, number>();
  for (const [, ids] of view.bite?.sections ?? []) {
    for (const id of ids) {
      const concept = conceptOf.get(id);
      if (concept) per.set(concept, (per.get(concept) ?? 0) + 1);
    }
  }
  let best: { name: string; n: number } | null = null;
  for (const c of view.concepts) {
    const n = per.get(c.id) ?? 0;
    if (n > 0 && (!best || n > best.n)) best = { name: c.name, n };
  }
  return best?.name ?? view.focusConcept?.name ?? view.exam.title;
}

const iconOf = (icon: string | null): ConceptIconName | undefined =>
  (CONCEPT_ICON_NAMES as readonly string[]).includes(icon ?? "") ? (icon as ConceptIconName) : undefined;

function progressConcepts(view: ExamView, deck: Deck): ProgressConcept[] {
  return view.concepts.map((c, i) => {
    // `conceptSession` takes the first four cards that touch the concept.
    const cards = Math.min(4, deck.cards.filter((card) => card.conceptIds.includes(c.id)).length);
    const lecture = Number(c.lecture?.match(/\d+/)?.[0]);
    return {
      id: c.id,
      name: c.name,
      // "Lecture 3" gives 3; a concept with no lecture number keeps its place in the exam.
      lecture: Number.isFinite(lecture) && lecture > 0 ? lecture : i + 1,
      weight: c.weight,
      mastery: c.mastery,
      icon: iconOf(c.icon),
      minutes: cards > 0 ? biteMinutes(cards) : null,
    };
  });
}

// ---------------------------------------------------------------------------

async function todayOf(
  user: User,
  view: ExamView,
  deck: Deck,
  aiStudy: (typeof AI_STUDY)[number],
  now: Date,
  quiet: string | null,
): Promise<ExamPageToday> {
  const today = dayKey(now);
  if (view.bite) {
    const following = view.bitesDoneToday + 2;
    return {
      state: "bite",
      more: view.bitesDoneToday > 0,
      minutes: view.bite.minutes,
      cards: view.bite.cards,
      gain: view.bite.gainEstimate,
      focus: biteFocus(view, deck),
      ...(following <= view.bitesPerDay
        ? { next: { number: following, of: view.bitesPerDay, minutes: view.bite.minutes } }
        : {}),
    };
  }
  if (quiet) return { state: "quiet", line: quiet };
  if (deck.cards.length > 0) return { state: "done", nextReviews: nextReviewsLine(view.nextReviews, today) };
  if (aiStudy !== "allowed") return { state: "ask", rule: aiStudy };

  // The Exams tab's check, for this exam only: `examView` is already read, so it is handed back.
  const list = await getExamsView(user.id, { now, view: async () => view });
  const making = list.exams.find((e) => e.id === view.exam.id)?.making;
  return making ? { state: "making", lectures: making.lectures } : { state: "empty" };
}

async function Exam({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  await connection();
  const user = await signedInUser();
  const now = new Date();

  let view: ExamView;
  let deck: Deck;
  try {
    view = await examView(id);
    deck = await loadDeck(user.id, view.exam.id);
  } catch (err) {
    if (err instanceof StudyNotFound) notFound();
    throw err;
  }
  const [course] = await db
    .select({ name: courses.name, aiStudy: courses.aiStudy, hidden: courses.hidden })
    .from(courses)
    .where(and(eq(courses.id, view.exam.courseId), eq(courses.userId, user.id)));
  if (!course || course.hidden) notFound();
  // What `examView` does not carry: the grade her bundle aims for, its study start, and whether
  // the clock time is a placeholder.
  const [stored] = await db
    .select({ gradeTarget: exams.gradeTarget, startNewOn: exams.startNewOn, wholeDay: exams.timeIsPlaceholder })
    .from(exams)
    .where(and(eq(exams.id, view.exam.id), eq(exams.userId, user.id)));

  const { exam } = view;
  const today = dayKey(now);
  const examDay = dayKey(exam.at);
  const at = partsOf(examDay);
  const courseName = shortNameOf(course.name);
  const tabs = await getExamTabs(user.id, { examId: exam.id, courseId: exam.courseId, courseName, now });
  // Before the study start: one calm line instead of a verdict, a done plan or a promised percent.
  const starts = startsOn(stored?.startNewOn, now);
  // The day after the exam (00:00 Helsinki) it is over: no "Exam day", no bite, no plan.
  const over = view.daysLeft < 0;
  const quiet = over ? OVER : starts ? startsLine(starts) : null;
  const from = typeof query.from === "string" && /^\d{1,3}$/.test(query.from) ? Math.min(100, Number(query.from)) : undefined;

  return (
    <ExamPage
      examId={exam.id}
      kind={exam.kind}
      course={courseName}
      sub={`${exam.title} · ${at.weekday} ${at.day} ${at.month}${stored?.wholeDay ? "" : ` ${clockOf.format(exam.at)}`}`}
      forecast={view.forecastShown}
      verdict={over ? OVER : starts ? `Starts ${starts}` : view.verdict.text}
      rollFrom={from !== undefined && from !== view.forecastShown ? from : undefined}
      today={await todayOf(user, view, deck, course.aiStudy, now, quiet)}
      documents={await loadExamDocuments(db, user.id, exam.id)}
      lectures={tabs.lectures}
      notes={tabs.notes}
      progress={{
        grade: gradeFor(view.forecastShown),
        planEnd: view.planEnd,
        dayName: byDay(exam.at, now),
        ...(quiet ? { note: quiet } : {}),
        chart: {
          history: view.history,
          forecast: view.forecast,
          daysLeft: view.daysLeft,
          target: exam.targetPct,
          targetGrade: targetGradeOf(stored?.gradeTarget),
          examDay: `${at.month} ${at.day}`.toUpperCase(),
        },
        concepts: progressConcepts(view, deck),
        focusId: view.focusConcept?.id ?? null,
        daysLeft: view.daysLeft,
        phaseNext: phaseNext(view.daysLeft, examDay),
        week: { days: view.week.days, count: view.week.count, goal: view.week.goal, met: view.week.met, sentence: view.week.sentence },
        weeksInARow: view.week.weeksInARow,
        freeSkipsLeft: view.week.freeSkipsLeft,
      }}
      practise={{
        counts: tileCounts(deck),
        reviews: reviewDays(view.nextReviews, today),
        heat: view.last14.map((d): HeatDay => ({ label: longDay(d.day), count: d.count })),
        gradeMode: view.gradeMode,
      }}
      setGradeMode={setGradeMode}
      setStudyRule={setStudyRule.bind(null, exam.id)}
    />
  );
}

export default function ExamRoute({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  return (
    <Suspense fallback={null}>
      <Exam params={params} searchParams={searchParams} />
    </Suspense>
  );
}

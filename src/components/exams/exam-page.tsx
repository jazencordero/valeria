"use client";

/**
 * Exam page (M3-42): one 760 px column with the header (M3-23), then three
 * tabs (M3-47) remembered per exam: Today, Progress, Practise. M9-23 adds
 * Lectures and Notes.
 * Source: prototype merged-2.html JS 3264-3271 (the page), 6029-6040
 * (progressHTML), 6063-6079 (practiseHTML) and CSS 1505-1513 (from 1000 px
 * the page fits one screen and each panel scrolls inside itself).
 *
 *  - Today: the bite block only (M3-24). While the cards are still being made
 *    it says so; while the course has no answer about AI tools it asks
 *    (`StudyAsk`, the M2-21 card for the course's study rule, `ai_study`).
 *  - Progress: the big percent, its sentence and the chart (side by side 5:7
 *    from 1000 px), WHERE YOU GAIN MOST, and the button that opens the "How
 *    it is going" sheet (M3-48).
 *  - Practise: WAYS TO PRACTISE tiles; beside them from 1000 px (below on
 *    phones) next reviews, the 14-day heatmap and how you grade.
 *
 * Plain data in. Starting anything goes to `/study/new?exam=..&kind=..`
 * (M3-43 builds that route). The two things this page saves are passed in as
 * actions: the grade-button setting (`setGradeMode`, M3-18) and the answer to
 * the AI question.
 *
 * Fit one screen: the app frame's page area (`main`) is the scroller. From
 * 1000 px this page is as tall as the page area minus where it starts (the
 * demo line sits above it for a demo user; `--exam-top` is measured), so the
 * page area has nothing to scroll and the open tab panel takes the height
 * that is left.
 * Cut: the Anki row (M8-14), open and close transitions (M4-14).
 */
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DoodleDefs } from "@/components/doodle";
import { makingLine } from "@/components/exams/exam-card";
import { BiteCard, type BiteCardNext } from "@/components/study/bite-card";
import { ExamHeader } from "@/components/study/exam-header";
import type { ForecastChartData } from "@/components/study/forecast-chart";
import { GainMost, type GainConcept } from "@/components/study/gain-most";
import { GradeMode, type GradeModeValue } from "@/components/study/grade-mode";
import { Heatmap, type HeatDay } from "@/components/study/heatmap";
import { NextReviews, type ReviewDay } from "@/components/study/next-reviews";
import { PracticeTiles, type PracticeType } from "@/components/study/practice-tiles";
import { ProgressHead } from "@/components/study/progress-head";
import { ProgressSheet, type ProgressConcept } from "@/components/study/progress-sheet";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import type { Week } from "@/lib/study/week";

/** `courses.ai_study`. */
export type StudyRule = "unknown" | "allowed" | "not_allowed";

export type StudyRuleResult =
  | { ok: true; rule: StudyRule }
  | { ok: false; reason: "invalid" | "not_found" | "signed_out" };

export type ExamPageToday =
  | {
      state: "bite";
      /** True once a bite is done today. */
      more: boolean;
      minutes: number;
      cards: number;
      /** Forecast gain in percentage points. */
      gain: number;
      /** Name of the concept most of the cards are about. */
      focus: string;
      next?: BiteCardNext;
    }
  | { state: "done"; /** "Next reviews tomorrow." */ nextReviews: string }
  /** The cards are being made from this many lectures. */
  | { state: "making"; lectures: number }
  /** No cards, and the course's study rule is not a yes. */
  | { state: "ask"; rule: Exclude<StudyRule, "allowed"> }
  /** No cards and nothing is making any. */
  | { state: "empty" };

export type ExamPageProps = {
  examId: string;
  /** Course name, the page heading and the name the AI question uses. */
  course: string;
  /** Mono line under the heading, for example "Exam · Fri 20 Nov 09:00". */
  sub: string;
  /** Today's forecast, a whole percent. */
  forecast: number;
  /** The verdict sentence. */
  verdict: string;
  /** The old forecast, when coming back from a session (`?from=<pct>`). */
  rollFrom?: number;
  today: ExamPageToday;
  progress: {
    /** Today's grade, 0..5. */
    grade: number;
    /** Where a bite a day ends on exam day, in percent. */
    planEnd: number;
    /** Exam weekday, for example "Friday". */
    dayName: string;
    chart: ForecastChartData;
    /** Every concept, in the exam's order. */
    concepts: readonly ProgressConcept[];
    focusId: string | null;
    daysLeft: number;
    /** "Final review starts Tue 17." */
    phaseNext?: string;
    week: Week;
    weeksInARow: number;
    freeSkipsLeft: number;
  };
  practise: {
    /** Cards per tile type. */
    counts: Record<PracticeType, number>;
    reviews: ReviewDay[];
    /** Oldest first, today last. */
    heat: HeatDay[];
    gradeMode: GradeModeValue;
  };
  /** Saves the grade-button setting. Usually `setGradeMode` from M3-18. */
  setGradeMode?: (mode: GradeModeValue) => Promise<GradeModeValue>;
  /** Saves the answer to the AI question. Usually the page's bound action. */
  setStudyRule?: (rule: StudyRule) => Promise<StudyRuleResult>;
  /** Tab shown first when nothing is remembered (previews). */
  defaultTab?: "today" | "progress" | "practise";
};

const CARD = "rounded-[20px] border border-solid border-line bg-surface p-5 shadow-[var(--shadow-card)]";

/**
 * A tab's content. From 1000 px it takes the height that is left and scrolls
 * inside itself, with a soft fade at its top and bottom edge.
 */
function Panel({ children }: { children: ReactNode }) {
  return (
    <div
      data-fit-scroll=""
      className={
        "[&>*+*]:mt-5 min-[1000px]:min-h-0 min-[1000px]:flex-1 min-[1000px]:overflow-y-auto " +
        "min-[1000px]:overscroll-contain min-[1000px]:px-0.5 min-[1000px]:pt-1.5 min-[1000px]:pb-3.5 " +
        "min-[1000px]:[mask-image:linear-gradient(to_bottom,transparent_0,black_12px,black_calc(100%-18px),transparent_100%)]"
      }
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Today: the AI question (the M2-21 card, for the course's study rule)

type StudyAnswer = "yes" | "no" | "not_sure";

const ANSWER_RULE: Record<StudyAnswer, StudyRule> = {
  yes: "allowed",
  no: "not_allowed",
  not_sure: "unknown",
};

const ANSWERS: { answer: StudyAnswer; label: string }[] = [
  { answer: "yes", label: "Yes" },
  { answer: "no", label: "No" },
  { answer: "not_sure", label: "Not sure" },
];

export const ONLY_AFTER_YES = "Cards are made from its slides only after a yes.";
export const STILL_ADD = "You can still add cards from your own notes or an Anki deck.";

/**
 * "Does <course> allow AI tools on its material? Check the syllabus." Yes
 * stores "allowed" (the page then shows the cards being made), No stores
 * "not_allowed", Not sure leaves "unknown" and hides the card for this view.
 */
function StudyAsk({
  course,
  rule: initial,
  setStudyRule,
}: {
  course: string;
  rule: Exclude<StudyRule, "allowed">;
  setStudyRule?: (rule: StudyRule) => Promise<StudyRuleResult>;
}) {
  const questionId = useId();
  const [rule, setRule] = useState<StudyRule>(initial);
  const [answered, setAnswered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<StudyAnswer | null>(null);
  const [failed, setFailed] = useState(false);

  // A new value from the server (after refresh) wins over the local copy.
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    setRule(initial);
  }

  const asking = editing || (rule === "unknown" && !answered);

  async function answer(choice: StudyAnswer) {
    if (pending || !setStudyRule) return;
    setPending(choice);
    setFailed(false);
    try {
      const result = await setStudyRule(ANSWER_RULE[choice]);
      if (result.ok) {
        setRule(result.rule);
        setAnswered(true);
        setEditing(false);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="study-ask">
      {asking && (
        <section aria-labelledby={questionId} className={CARD}>
          <p id={questionId} className="text-[15px] leading-[1.45] text-ink">
            Does {course} allow AI tools on its material?{" "}
            <span className="text-ink-2">Check the syllabus.</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {ANSWERS.map(({ answer: choice, label }) => (
              <Button
                key={choice}
                variant="secondary"
                size="sm"
                loading={pending === choice}
                disabled={pending !== null && pending !== choice}
                onClick={() => answer(choice)}
              >
                {label}
              </Button>
            ))}
          </div>
          {failed && (
            <p role="alert" className="mt-2.5 text-[14px] text-ink">
              Could not save that. Try again.
            </p>
          )}
        </section>
      )}
      <p className="text-[14px] leading-[1.45] text-ink-2">
        {ONLY_AFTER_YES}
        {rule === "not_allowed" && ` ${STILL_ADD}`}
        {!asking && (
          <>
            {" "}
            <button
              type="button"
              onClick={() => {
                setFailed(false);
                setEditing(true);
              }}
              className="font-medium text-ink underline decoration-ink-3 underline-offset-2 hover:decoration-ink"
            >
              Change answer
            </button>
          </>
        )}
      </p>
    </div>
  );
}

function Making({ lectures }: { lectures: number }) {
  const labelId = useId();
  return (
    <section className={CARD} aria-labelledby={labelId} data-testid="making-cards">
      <h2 id={labelId} className="text-[24px] leading-[1.2]">
        Making your cards
      </h2>
      <p className="mt-1.5 text-[15px] text-ink-2">{makingLine(lectures)}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------

export function ExamPage({
  examId,
  course,
  sub,
  forecast,
  verdict,
  rollFrom,
  today,
  progress,
  practise,
  setGradeMode,
  setStudyRule,
  defaultTab = "today",
}: ExamPageProps) {
  const router = useRouter();
  const pathname = usePathname();

  /** `/study/new?exam=<id>&kind=<kind>`; a tile or a concept session also names its `arg`. */
  const start = (kind: "bite" | "extra" | "tile" | "concept", arg?: string) => {
    const query = new URLSearchParams({ exam: examId, kind });
    if (arg) query.set("arg", arg);
    router.push(`/study/new?${query.toString()}`);
  };

  // `?from=` has done its job once the number has rolled: drop it, so a reload
  // does not roll again from an old value.
  useEffect(() => {
    if (rollFrom == null) return;
    if (!new URLSearchParams(window.location.search).has("from")) return;
    window.history.replaceState(null, "", pathname);
  }, [rollFrom, pathname]);

  // Where the page starts inside the page area (0, or the demo line's height).
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = rootRef.current;
    const area = el?.parentElement;
    if (!el || !area) return;
    const measure = () => el.style.setProperty("--exam-top", `${el.offsetTop}px`);
    measure();
    // The demo line streams in on its own, and wraps at some widths.
    const added = new MutationObserver(measure);
    added.observe(area, { childList: true });
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resized?.observe(area);
    return () => {
      added.disconnect();
      resized?.disconnect();
    };
  }, []);

  // The Progress chart draws the first time its tab is shown.
  const [progressShown, setProgressShown] = useState(false);

  // How you grade: shown at once, saved behind; a failed save puts it back.
  const [gradeMode, setMode] = useState<GradeModeValue>(practise.gradeMode);
  const [savedMode, setSavedMode] = useState(practise.gradeMode);
  if (practise.gradeMode !== savedMode) {
    setSavedMode(practise.gradeMode);
    setMode(practise.gradeMode);
  }
  const changeMode = (next: GradeModeValue) => {
    const before = gradeMode;
    setMode(next);
    setGradeMode?.(next).catch(() => setMode(before));
  };

  const todayPanel =
    today.state === "bite" ? (
      <BiteCard
        state="bite"
        more={today.more}
        minutes={today.minutes}
        cards={today.cards}
        gain={today.gain}
        focus={today.focus}
        next={today.next}
        onStart={() => start("bite")}
      />
    ) : today.state === "done" ? (
      <BiteCard state="done" nextReviews={today.nextReviews} onPractise={() => start("extra")} />
    ) : today.state === "making" ? (
      <Making lectures={today.lectures} />
    ) : today.state === "ask" ? (
      <StudyAsk course={course} rule={today.rule} setStudyRule={setStudyRule} />
    ) : (
      <p className="py-3 text-[15px] text-ink-2" data-testid="no-cards">
        No cards for this one yet.
      </p>
    );

  const gain: GainConcept[] = progress.concepts.map((c) => ({
    id: c.id,
    name: c.name,
    weight: c.weight,
    mastery: c.mastery,
    icon: c.icon,
  }));

  const progressPanel = (
    <>
      <ProgressHead
        forecast={forecast}
        grade={progress.grade}
        planEnd={progress.planEnd}
        dayName={progress.dayName}
        chart={progress.chart}
        shown={progressShown}
        rollFrom={rollFrom}
        className={
          "min-[1000px]:grid min-[1000px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] min-[1000px]:items-center " +
          "min-[1000px]:gap-x-6 min-[1000px]:[&>*+*]:mt-0 min-[1000px]:[&>*+*]:border-t-0 min-[1000px]:[&>*+*]:pt-0"
        }
      />
      {gain.length > 0 && <GainMost concepts={gain} />}
      <ProgressSheet
        concepts={progress.concepts}
        focusId={progress.focusId}
        daysLeft={progress.daysLeft}
        phaseNext={progress.phaseNext}
        week={progress.week}
        weeksInARow={progress.weeksInARow}
        freeSkipsLeft={progress.freeSkipsLeft}
        onPractise={(conceptId) => start("concept", conceptId)}
      />
    </>
  );

  const practisePanel = (
    <div className="grid gap-6 min-[1000px]:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] min-[1000px]:items-start">
      <PracticeTiles counts={practise.counts} onStart={(type) => start("tile", type)} />
      <div className="grid gap-3.5">
        <NextReviews days={practise.reviews} />
        <Heatmap days={practise.heat} />
        <GradeMode value={gradeMode} onChange={changeMode} />
      </div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      data-testid="exam-page"
      className={
        "mx-auto max-w-[760px] px-[var(--pad)] pt-[max(20px,env(safe-area-inset-top,0px))] pb-10 " +
        "min-[1000px]:flex min-[1000px]:h-[calc(100%-var(--exam-top,0px))] min-[1000px]:flex-col min-[1000px]:pb-6"
      }
    >
      <DoodleDefs />
      <ExamHeader
        course={course}
        sub={sub}
        forecast={forecast}
        verdict={verdict}
        rollFrom={rollFrom}
        backHref="/exams"
        className="min-[1000px]:flex-none"
      />
      <Tabs
        label="Exam"
        memoryKey={`exam.${examId}`}
        defaultTab={defaultTab}
        onShown={(id) => {
          if (id === "progress") setProgressShown(true);
        }}
        tabs={[
          { id: "today", label: "Today", content: <Panel>{todayPanel}</Panel> },
          { id: "progress", label: "Progress", content: <Panel>{progressPanel}</Panel> },
          { id: "practise", label: "Practise", content: <Panel>{practisePanel}</Panel> },
        ]}
        className={
          "min-[1000px]:flex min-[1000px]:min-h-0 min-[1000px]:flex-1 min-[1000px]:flex-col " +
          "min-[1000px]:[&>[role=tabpanel]:not([hidden])]:flex min-[1000px]:[&>[role=tabpanel]]:min-h-0 " +
          "min-[1000px]:[&>[role=tabpanel]]:flex-1 min-[1000px]:[&>[role=tabpanel]]:flex-col"
        }
      />
    </div>
  );
}

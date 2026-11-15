"use client";

/**
 * One course's grade page (M6-08): the head from M6-06, then three tabs.
 *
 * - **Overview**: the verdict, "Aiming for" 1 to 5, what she needs and what
 *   matters most (`Overview`, M6-06).
 * - **What if**: the trajectory chart (M6-05), mounted the first time the tab
 *   is shown so its line draws in view, then the what-is-left rows with
 *   sliders and "Reset what-ifs" (`LeftRows`, M6-07).
 * - **Graded**: graded items and still to come (`GradedList`, M6-07).
 *
 * A course that needs weights shows the weights card (M6-04) instead of the
 * tabs.
 *
 * Holds the target and the what-ifs. The target is saved per course through
 * `saveTarget` (a Server Action the page passes in); the choice shows at once
 * and goes back if the save fails. What-ifs live in memory only. The chosen
 * tab is remembered per course in localStorage (a blocked storage just means
 * it is not remembered).
 *
 * Opened from a row (the Grades list or Home's grades card) the page reveals
 * out of that row (360 ms), and "Back to grades" goes back to the page the
 * row is on, puts its scroll back and shrinks into the row (320 ms) (M9-18,
 * `cardArrival` / `closeCardPage` in `@/lib/motion/shared`; reduced motion:
 * a fade, no View Transitions: a slide). While it reveals the What if chart
 * waits, so its line still draws in view.
 *
 * Source: prototype merged.html HTML 1834-1840, CSS 1447-1462, JS 6021-6074.
 */
import { useRouter } from "next/navigation";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type MouseEvent,
} from "react";
import type { CourseColor } from "@/components/shell/side-nav";
import { GradeHead } from "@/components/grades/grade-head";
import { GradedList } from "@/components/grades/graded-list";
import { LeftRows } from "@/components/grades/left-rows";
import { Overview, type GradeTarget } from "@/components/grades/overview";
import { TrajectoryChart } from "@/components/grades/trajectory-chart";
import { NeedsWeightsCard, type SaveWeightsAction } from "@/components/grades/weights-form";
import { Tabs } from "@/components/ui/tabs";
import {
  chartSeries,
  mattersMost,
  NEEDS_WEIGHTS,
  normaliseWeights,
  soFar,
  trajectory,
  verdict,
  type WhatIfs,
} from "@/lib/grades/model";
import {
  EXAM_PAGE,
  WORK_TRANSITION_CSS,
  cardArrival,
  cardRevealPending,
  closeCardPage,
  leaveCardPage,
} from "@/lib/motion/shared";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { GradePageItem } from "@/server/data/grades";

export type SaveTargetAction = (
  courseId: string,
  target: number,
) => Promise<{ ok: true } | { ok: false; message: string }>;

export type GradePageProps = {
  course: { id: string; name: string; code: string | null; color: CourseColor; target: GradeTarget };
  /** Every grade item of the course, in report order, scores in percent. */
  items: GradePageItem[];
  needsWeights: boolean;
  /** Parts seeded by hand in points: show the weights and what is known, nothing derived. */
  weightsOnly?: boolean;
  /** What her school calls its Moodle (`lmsNameOf(user)`). */
  lmsName: string;
  saveTarget: SaveTargetAction;
  saveWeights: SaveWeightsAction;
  /** Where "Back to grades" goes. */
  backHref?: string;
};

export type GradeTab = "overview" | "whatif" | "graded";
const TAB_IDS: readonly GradeTab[] = ["overview", "whatif", "graded"];
const TAB_KEY = "ready.grades.tab.";

function readTab(courseId: string): GradeTab | null {
  try {
    const v = window.localStorage.getItem(TAB_KEY + courseId);
    return TAB_IDS.includes(v as GradeTab) ? (v as GradeTab) : null;
  } catch {
    return null;
  }
}

function writeTab(courseId: string, tab: string) {
  try {
    window.localStorage.setItem(TAB_KEY + courseId, tab);
  } catch {
    // Storage can be blocked (private mode); the tab still works.
  }
}

const noopSubscribe = () => () => {};

export function GradePage({
  course,
  items,
  needsWeights,
  weightsOnly = false,
  lmsName,
  saveTarget,
  saveWeights,
  backHref = "/grades",
}: GradePageProps) {
  const [target, setTarget] = useState<GradeTarget>(course.target);
  const [whatIfs, setWhatIfs] = useState<WhatIfs>({});
  const [chartShown, setChartShown] = useState(false);
  const [, startSaving] = useTransition();

  // Opened from a row: the page reveals out of it (M9-18). Until it has, the
  // chart waits (`held`). The grade page's timings are the exam page's.
  const router = useRouter();
  const mode = useMotionMode();
  const rootRef = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState(() => cardRevealPending());
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const wait = cardArrival(el);
    const timer = window.setTimeout(() => setHeld(false), wait);
    return () => {
      window.clearTimeout(timer);
      leaveCardPage(el);
    };
  }, []);

  /** "Back to grades": back into the row the page was opened from (the list or Home). */
  const back = (e: MouseEvent<HTMLElement>) => {
    const link = (e.target as Element).closest("a");
    if (!link || link.getAttribute("href") !== backHref) return;
    closeCardPage(
      e,
      link,
      mode,
      rootRef.current,
      (path) => router.push(path, { scroll: false }),
      backHref,
      EXAM_PAGE,
    );
  };
  const transitionCss = (
    <style href="ready-work-transition" precedence="default">
      {WORK_TRANSITION_CSS}
    </style>
  );

  // Read on the client only, so the server render stays plain.
  const rememberedTab = useSyncExternalStore(
    noopSubscribe,
    () => readTab(course.id),
    () => null,
  );

  const onTargetChange = (next: GradeTarget) => {
    if (next === target) return;
    const before = target;
    setTarget(next);
    startSaving(async () => {
      const result = await saveTarget(course.id, next).catch(() => ({ ok: false as const, message: "" }));
      if (!result.ok) setTarget(before);
    });
  };

  const onShown = useCallback((id: string) => {
    if (id === "whatif") setChartShown(true);
  }, []);
  const onTabChange = useCallback((id: string) => writeTab(course.id, id), [course.id]);

  const sf = soFar(items);
  const traj = trajectory(items, whatIfs);
  const head = {
    trajectory: traj === NEEDS_WEIGHTS ? null : traj,
    transcript: sf == null || sf === NEEDS_WEIGHTS || traj == null || traj === NEEDS_WEIGHTS
      ? null
      : Math.floor(traj + 1e-9),
  };
  const v = verdict(items, target);

  const headEl = (
    <GradeHead
      name={course.name}
      code={course.code ?? ""}
      dot={course.color}
      trajectory={head.trajectory}
      transcript={head.transcript}
      verdict={v}
      target={target}
      backHref={backHref}
    />
  );

  if (weightsOnly && !needsWeights) {
    // No verdict, no "you need", no trajectory: this course is marked in points with its own
    // grade bands, which are not stored yet, so the percent scale could say something false.
    return (
      <div ref={rootRef} onClickCapture={back}>
        {transitionCss}
        <GradeHead
          name={course.name}
          code={course.code ?? ""}
          dot={course.color}
          trajectory={null}
          transcript={null}
          verdict={{ kind: "needs_weights" }}
          target={target}
          backHref={backHref}
        />
        <section aria-labelledby="weights-only" className="mt-6">
          <h2 id="weights-only" className="mono text-ink-3">
            HOW THIS COURSE IS GRADED
          </h2>
          <ul className="mt-2">
            {items.map((it) => (
              <li
                key={it.id}
                className="flex items-baseline justify-between gap-4 border-t border-solid border-line py-3 first:border-t-0"
              >
                <span className="min-w-0 text-[15px] [overflow-wrap:anywhere]">{it.name}</span>
                <span className="mono shrink-0 text-ink-2">
                  {it.weight == null ? "" : `${Math.round(it.weight * 1000) / 10}%`}
                  {it.score == null ? "" : ` · ${Math.round(it.score)}% scored`}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[13px] text-ink-3">
            This course is marked in points with its own grade limits, so Ready does not work out a grade for it yet.
          </p>
        </section>
      </div>
    );
  }

  if (needsWeights) {
    return (
      <div ref={rootRef} onClickCapture={back}>
        {transitionCss}
        {headEl}
        <div className="mt-6">
          <NeedsWeightsCard
            course={{ id: course.id, name: course.name }}
            items={items.map((it) => ({ id: it.id, name: it.name, weight: it.weight }))}
            lmsName={lmsName}
            action={saveWeights}
          />
        </div>
      </div>
    );
  }

  const norm = normaliseWeights(items);
  const mm = mattersMost(items, whatIfs);
  const mmWeight =
    mm && mm !== NEEDS_WEIGHTS && norm !== NEEDS_WEIGHTS ? norm.find((n) => n.id === mm.id)?.weight ?? 0 : 0;
  const series = chartSeries(items, whatIfs);

  return (
    <div ref={rootRef} onClickCapture={back}>
      {transitionCss}
      {headEl}
      <Tabs
        label="Course grade"
        defaultTab={rememberedTab ?? "overview"}
        stickyTop={52}
        onShown={onShown}
        onChange={onTabChange}
        tabs={[
          {
            id: "overview",
            label: "Overview",
            content: (
              <Overview
                verdict={v}
                target={target}
                onTargetChange={onTargetChange}
                mattersMost={mm && mm !== NEEDS_WEIGHTS ? { name: mm.name, weight: mmWeight } : null}
              />
            ),
          },
          {
            id: "whatif",
            label: "What if",
            content: (
              <>
                {chartShown && !held && series !== NEEDS_WEIGHTS ? (
                  <TrajectoryChart
                    items={items.map((it) => ({ id: it.id, short: it.short, name: it.name }))}
                    series={series}
                    target={target}
                  />
                ) : (
                  <div aria-hidden="true" className="h-[156px]" />
                )}
                <LeftRows
                  items={items}
                  whatIfs={whatIfs}
                  onRelease={(id, value) => setWhatIfs((w) => ({ ...w, [id]: value }))}
                  onReset={() => setWhatIfs({})}
                />
              </>
            ),
          },
          {
            id: "graded",
            label: "Graded",
            content: <GradedList items={items} />,
          },
        ]}
      />
    </div>
  );
}

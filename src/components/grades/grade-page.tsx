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
 * Source: prototype merged.html HTML 1834-1840, CSS 1447-1462.
 */
import { useCallback, useState, useSyncExternalStore, useTransition } from "react";
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
  lmsName,
  saveTarget,
  saveWeights,
  backHref = "/grades",
}: GradePageProps) {
  const [target, setTarget] = useState<GradeTarget>(course.target);
  const [whatIfs, setWhatIfs] = useState<WhatIfs>({});
  const [chartShown, setChartShown] = useState(false);
  const [, startSaving] = useTransition();

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

  if (needsWeights) {
    return (
      <div>
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
    <div>
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
                {chartShown && series !== NEEDS_WEIGHTS ? (
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

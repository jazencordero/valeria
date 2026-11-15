/**
 * "Where your grades are heading" on Home's rail (M6-09): a butter card with
 * one row per course. Each row has the course name ("too early" under it
 * while nothing is graded), five pips filled to the whole grade of the
 * trajectory with the target pip outlined in rose (the accent), and the
 * trajectory number (a muted dash while there is none). A row links to that
 * course's grade page; "Open grades" goes to the list.
 *
 * Plain data in: the rows are `getGradesList`'s (src/server/data/grades.ts,
 * via `getHomeView`), no fetching, no client code. Source: prototype
 * merged.html JS 4179-4183 (the rows), CSS 454-470 (.gcard, .g-title, .g-sub)
 * and the row/scale rules beside them (.g-row, .g-name, .g-early, .scale,
 * .scale i.tgt, .g-val).
 *
 * Cut: rows no longer open a sentence in place; they go to the grade page.
 * The prototype's half pip and its "Sample data in this demo" foot are left
 * out (whole grades only).
 *
 * With no courses the card is not drawn (returns null).
 */
import Link from "next/link";
import { useId } from "react";
import type { GradesListRow } from "@/server/data/grades";

export type GradesCardRow = Pick<GradesListRow, "id" | "href" | "name" | "status" | "target" | "trajectory">;

export type GradesCardProps = {
  courses: GradesCardRow[];
  /** What her school calls its Moodle (`lmsNameOf(user)`). */
  lmsName: string;
  className?: string;
};

/** One decimal, as the prototype's fmt1. */
const fmt1 = (g: number) => (Math.round(g * 10) / 10).toFixed(1);

/** The whole grade 0..5 a trajectory reaches (the 1e-9 absorbs float noise, as `gradeStep`). */
export function wholeGrade(trajectory: number | null): number {
  if (trajectory == null || !Number.isFinite(trajectory)) return 0;
  return Math.min(5, Math.max(0, Math.floor(trajectory + 1e-9)));
}

/** Nothing graded yet: the prototype's `soFar(c) == null`. */
const tooEarly = (c: GradesCardRow) => c.status === "early";

function Scale({ filled, target }: { filled: number; target: number }) {
  return (
    <span aria-hidden="true" className="inline-flex gap-[3px]" data-filled={filled} data-target={target}>
      {[1, 2, 3, 4, 5].map((k) => (
        <i
          key={k}
          data-on={k <= filled ? "" : undefined}
          data-target={k === target ? "" : undefined}
          className={
            "block h-1.5 w-2.5 rounded-[2px] " +
            (k <= filled ? "bg-ink" : "bg-[color-mix(in_oklch,var(--ink)_14%,transparent)]") +
            (k === target ? " shadow-[0_0_0_1.5px_var(--accent)]" : "")
          }
        />
      ))}
    </span>
  );
}

export function GradesCard({ courses, lmsName, className = "" }: GradesCardProps) {
  const labelId = useId();
  if (courses.length === 0) return null;
  return (
    <section
      className={`rounded-[20px] bg-butter p-[18px] text-ink ${className}`}
      aria-labelledby={labelId}
      data-testid="grades-card"
    >
      <h2 id={labelId} className="text-[18px] leading-[1.25]">
        Where your grades are heading
      </h2>
      <p className="mt-1 text-[13px] text-ink-2">From your graded work in {lmsName}. Finnish scale, 0 to 5.</p>

      <ul className="mt-2.5 list-none p-0">
        {courses.map((c) => {
          const early = tooEarly(c);
          return (
            <li key={c.id}>
              <Link
                href={c.href}
                data-testid={`grades-card-row-${c.id}`}
                className={
                  "grid min-h-[52px] w-full grid-cols-[minmax(0,1fr)_auto_44px] items-center gap-x-3 py-1.5 " +
                  "border-t border-solid border-[color-mix(in_oklch,var(--ink)_12%,transparent)] " +
                  "text-left text-ink no-underline"
                }
              >
                <span className="min-w-0 text-[15px] font-medium">
                  <span className="block truncate">{c.name}</span>
                  {early && <span className="mono mt-px block text-ink-2">too early</span>}
                </span>
                <Scale filled={wholeGrade(c.trajectory)} target={c.target} />
                <span
                  className={
                    "text-right font-display font-semibold leading-none [font-variation-settings:'SOFT'_100] " +
                    (c.trajectory == null ? "text-[22px] text-ink-2" : "text-[28px]")
                  }
                >
                  {c.trajectory == null ? (
                    <>
                      <span aria-hidden="true">–</span>
                      <span className="sr-only">no trajectory yet, aiming for {c.target}</span>
                    </>
                  ) : (
                    <>
                      {fmt1(c.trajectory)}
                      <span className="sr-only"> on this trajectory, aiming for {c.target}</span>
                    </>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      <Link
        href="/grades"
        className={
          "mt-1 inline-flex min-h-11 items-center text-[15px] font-semibold text-ink " +
          "underline decoration-[color-mix(in_oklch,var(--ink)_25%,transparent)] decoration-2 underline-offset-[5px] " +
          "hover:decoration-accent"
        }
      >
        Open grades
      </Link>
    </section>
  );
}

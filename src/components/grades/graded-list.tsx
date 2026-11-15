/**
 * "GRADED" and "STILL TO COME" for one course.
 *
 * GRADED: one row per graded item, "Assignment 1" with "10% · 90%" on the
 * right, or "Nothing graded yet." STILL TO COME: one row per ungraded item,
 * "Exam" with "60% · Exam week"; an item handed in but not graded reads
 * "Handed in, waiting for a grade" instead of its date. The section is left
 * out when nothing is still to come.
 *
 * Plain data in, no fetching. Weights shown as in the what-if rows
 * (`weightLabels`, model.ts `normaliseWeights`).
 * Source: prototype main-flow.html CSS 523-524 and 541-542 (.graded-list).
 */
import {
  NEEDS_WEIGHTS,
  normaliseWeights,
  type GradeItem,
  type GradeUnit,
} from "@/lib/grades/model";

/** One gradable item as the grade rows show it. */
export type RowItem = GradeItem & {
  name: string;
  /** When it is due or happens, for example "Exam week". */
  when?: string;
  /** Handed in but not graded yet (graded list only). */
  handedIn?: boolean;
};

export const SECTION_LABEL =
  "mono mb-1 mt-5 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]";

/**
 * How much each item counts, for display: "60%" of the grade in a share
 * course (weights scaled to add up to 100%), "20 points" in a points course.
 * `null` per item when the course has no usable weights.
 */
export function weightLabels(
  items: readonly GradeItem[],
  unit: GradeUnit = "share",
): Record<string, string | null> {
  const n = normaliseWeights(items, { unit });
  const out: Record<string, string | null> = {};
  items.forEach((it, i) => {
    if (n === NEEDS_WEIGHTS) out[it.id] = null;
    else if (unit === "points") out[it.id] = `${Math.round(n[i].weight * 10) / 10} points`;
    else out[it.id] = `${Math.round(n[i].weight * 100)}%`;
  });
  return out;
}

export type GradedListProps = {
  /** Every item of the course, graded and not. */
  items: RowItem[];
  unit?: GradeUnit;
  className?: string;
};

const ROW =
  "flex justify-between gap-3 border-t border-solid border-line py-2 text-[13px]";

function Row({ id, name, right }: { id: string; name: string; right: string }) {
  return (
    <li data-testid={`row-${id}`} className={ROW}>
      <span>{name}</span>
      <span className="sr-only"> · </span>
      <span className="mono text-right text-ink-2">{right}</span>
    </li>
  );
}

export function GradedList({ items, unit = "share", className = "" }: GradedListProps) {
  const weights = weightLabels(items, unit);
  const graded = items.filter((it) => it.score != null);
  const toCome = items.filter((it) => it.score == null);
  const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");

  return (
    <div className={className}>
      <h3 className={SECTION_LABEL}>Graded</h3>
      {graded.length ? (
        <ul className="list-none">
          {graded.map((it) => (
            <Row
              key={it.id}
              id={it.id}
              name={it.name}
              right={join(weights[it.id], `${Math.round(it.score as number)}%`)}
            />
          ))}
        </ul>
      ) : (
        <p className="border-t border-solid border-line py-2 text-[13px] text-ink-2">
          Nothing graded yet.
        </p>
      )}

      {toCome.length > 0 && (
        <>
          <h3 className={SECTION_LABEL}>Still to come</h3>
          <ul className="list-none">
            {toCome.map((it) => (
              <Row
                key={it.id}
                id={it.id}
                name={it.name}
                right={join(
                  weights[it.id],
                  it.handedIn ? "Handed in, waiting for a grade" : it.when,
                )}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

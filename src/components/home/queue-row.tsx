/**
 * QueueRow: one row of the "Then" list on Home, and Queue, the list around it.
 * Source: prototype main-flow.html HTML 1463-1475 (.queue, .q-row) and
 * CSS 345-347 (.row-title, .row-course, .row-meta), 372 (.tag) and 437-442
 * (.q-row, .q-num, .q-side, .chip-s).
 *
 * Number circle, title, course, date, and on the right the estimate plus a
 * status: a `Not started` or `Draft saved` chip, or the NEW tag.
 * Plain data in, no fetching. Cut: no lift or collapse animation (M4-13).
 */
import type { HTMLAttributes, ReactNode } from "react";
import { Tag } from "@/components/ui/tag";
import { listDate, minutesLabel, type DateInput } from "@/lib/dates";

export type QueueStatus = "not_started" | "draft_saved" | "new";

const CHIP_TEXT: Record<Exclude<QueueStatus, "new">, string> = {
  not_started: "Not started",
  draft_saved: "Draft saved",
};

export type QueueRowProps = {
  /** Place in the order; the hero card is 1, so the list usually starts at 2. */
  position: number;
  title: string;
  course: string;
  /** Null when the LMS gives no due date; the date line is then left out. */
  dueAt: DateInput | null;
  /** Estimated minutes of work. Missing or null hides the estimate. */
  estimateMin?: number | null;
  status: QueueStatus;
  /** Optional trailing action under the status, e.g. a Start button. */
  action?: ReactNode;
  className?: string;
};

export function QueueRow({
  position,
  title,
  course,
  dueAt,
  estimateMin,
  status,
  action,
  className = "",
}: QueueRowProps) {
  const hasEstimate = typeof estimateMin === "number" && estimateMin > 0;

  return (
    <li
      className={
        "-mx-2 grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3.5 px-2 py-3.5 " +
        "border-t border-solid border-line first:border-t-0 " +
        className
      }
    >
      <span className="mono grid size-7 place-items-center overflow-hidden rounded-full border border-solid border-line text-ink-2">
        {position}
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-medium [overflow-wrap:anywhere]">{title}</p>
        <p className="mt-0.5 text-[13px] text-ink-3">{course}</p>
        {dueAt != null && <p className="mono mt-0.5 text-ink-3">{listDate(dueAt)}</p>}
      </div>
      <div className="flex flex-col items-end gap-1.5 text-right">
        {hasEstimate && (
          <span className="mono whitespace-nowrap text-ink-2">{minutesLabel(estimateMin)}</span>
        )}
        {status === "new" ? (
          <Tag>NEW</Tag>
        ) : (
          <span className="whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-[12px] text-ink-2">
            {CHIP_TEXT[status]}
          </span>
        )}
        {action}
      </div>
    </li>
  );
}

/** The ordered list the rows sit in (`.queue`). */
export function Queue({ className = "", children, ...rest }: HTMLAttributes<HTMLOListElement>) {
  return (
    <ol {...rest} className={"list-none " + className}>
      {children}
    </ol>
  );
}

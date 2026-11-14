/**
 * DoneRow: mint check circle, title and a mono meta line, for something finished.
 * Source: prototype main-flow.html CSS 358-359 (.done-ic), 383-386 (.done-row) and
 * the row-title / row-meta text styles at 345-347.
 * Renders a div, or an li inside a list (`as="li"`). `trailing` fills the right column.
 */
import type { ReactNode } from "react";

export type DoneRowProps = {
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  as?: "div" | "li";
  className?: string;
  id?: string;
};

export function DoneRow({ title, meta, trailing, as = "div", className = "", id }: DoneRowProps) {
  const Tag = as;
  return (
    <Tag
      id={id}
      className={
        "grid min-h-14 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3.5 py-2 " + className
      }
    >
      <span className="grid size-7 place-items-center rounded-full bg-mint text-accent">
        <svg className="ic [stroke-width:2]" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 12.5l4 4L18 8" />
        </svg>
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-medium [overflow-wrap:anywhere]">{title}</p>
        {meta ? <p className="mono ink-3 mt-0.5 [overflow-wrap:anywhere]">{meta}</p> : null}
      </div>
      <span>{trailing}</span>
    </Tag>
  );
}

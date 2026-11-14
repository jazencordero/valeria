"use client";

/**
 * Tab bar: the frame's bottom row under 700 px (hidden from 700 px).
 * Source: prototype merged.html HTML 1891-1896 and CSS 395-401.
 *
 * Home, Courses, Exams, Notes as links, then More, which opens the More
 * sheet. Which tab is lit is `tabCurrent` in `nav-items.ts`: a course or a
 * lecture lights Courses; Assignments, Grades and Calendar light More.
 * Cut (M4): tab transitions and badges.
 *
 * `TabBar` reads the path and owns the sheet; `TabBarView` is the bare row,
 * used as the layout's Suspense fallback and by previews.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { MoreSheet } from "./more-sheet";
import { MORE_ICON, MORE_LABEL, TAB_ITEMS, tabCurrent } from "./nav-items";
import { NavIcon } from "./side-nav";

const ITEM =
  "group flex min-h-[58px] min-w-0 flex-1 flex-col items-center justify-center gap-[3px] " +
  "border-0 bg-transparent px-0.5 pt-1.5 pb-1 text-[11px] font-medium text-ink-3 no-underline " +
  "aria-[current=page]:font-semibold aria-[current=page]:text-ink";

const LABEL = "max-w-full overflow-hidden text-ellipsis whitespace-nowrap";

function Dot() {
  return (
    <i
      aria-hidden="true"
      className="h-1 w-1 rounded-full bg-accent opacity-0 transition-opacity duration-quick ease-out group-aria-[current=page]:opacity-100"
    />
  );
}

export type TabBarViewProps = {
  pathname: string | null;
  moreOpen?: boolean;
  onMore?: () => void;
};

export function TabBarView({ pathname, moreOpen = false, onMore }: TabBarViewProps) {
  const current = tabCurrent(pathname);
  return (
    <nav
      aria-label="Main"
      className="flex border-t border-line bg-surface px-[max(4px,env(safe-area-inset-left,0px))] pb-[env(safe-area-inset-bottom,0px)] min-[700px]:hidden"
      style={{ paddingRight: "max(4px, env(safe-area-inset-right, 0px))" }}
    >
      {TAB_ITEMS.map((item) => (
        <Link
          key={item.id}
          href={item.href}
          aria-current={current === item.id ? "page" : undefined}
          className={ITEM}
        >
          <NavIcon shapes={item.icon} className="!h-[22px] !w-[22px]" />
          <span className={LABEL}>{item.label}</span>
          <Dot />
        </Link>
      ))}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        aria-current={current === "more" ? "page" : undefined}
        onClick={onMore}
        className={ITEM}
      >
        <NavIcon shapes={MORE_ICON} className="!h-[22px] !w-[22px]" />
        <span className={LABEL}>{MORE_LABEL}</span>
        <Dot />
      </button>
    </nav>
  );
}

export function TabBar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <>
      <TabBarView pathname={pathname} moreOpen={open} onMore={() => setOpen(true)} />
      <MoreSheet open={open} onClose={() => setOpen(false)} pathname={pathname} />
    </>
  );
}

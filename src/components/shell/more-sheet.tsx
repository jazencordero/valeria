"use client";

/**
 * More sheet: what the tab bar's More opens on phones.
 * Source: prototype merged.html HTML 2026-2035.
 *
 * "More" with one 52 px row each for Assignments, Grades and Calendar.
 * Picking a row closes the sheet and goes there.
 * Cut (M4): the Dark mode row and the Assignments badge.
 */
import Link from "next/link";
import { Sheet } from "@/components/ui/sheet";
import { MORE_ITEMS, MORE_LABEL, isUnder } from "./nav-items";
import { NavIcon } from "./side-nav";

export type MoreSheetProps = {
  open: boolean;
  onClose: () => void;
  /** Current path, to mark the row of the page she is on. */
  pathname: string | null;
};

export function MoreSheet({ open, onClose, pathname }: MoreSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={MORE_LABEL} data-testid="more-sheet">
      <ul className="mt-3 grid list-none gap-0.5">
        {MORE_ITEMS.map((item) => (
          <li key={item.id}>
            <Link
              href={item.href}
              onClick={onClose}
              aria-current={isUnder(pathname, item.href) ? "page" : undefined}
              className={
                "flex h-[52px] items-center gap-3 rounded-xl px-3.5 text-[15px] font-medium text-ink no-underline " +
                "transition-colors duration-quick ease-out [@media(hover:hover)]:hover:bg-paper " +
                "aria-[current=page]:font-semibold"
              }
            >
              <NavIcon shapes={item.icon} className="!h-5 !w-5 text-ink-2" />
              <span>{item.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

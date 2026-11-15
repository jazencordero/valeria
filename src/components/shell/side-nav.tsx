"use client";

/**
 * Side nav: the frame's left column from 700 px (hidden below).
 * Source: prototype merged.html HTML 1621-1644, CSS 390-423 and 942-950.
 *
 * Wordmark with the tiny cap, the main links, her courses and a user chip
 * that opens Settings. Current page gets `aria-current="page"`.
 * Cut (M4, M9-13): the moving indicator, badges, the theme button and Notes.
 *
 * Folds to a 72 px icon rail (M4-01, main-flow.html CSS 387-420): the button
 * in the head toggles it, state and animation live in `use-side.ts`. Width
 * and label fades read `--side-c` (1 folded, 0 open), which the app layout
 * sets from <html data-side> and the screen width, so the first paint is
 * already right. Folded, labels fade but stay in the DOM as the links'
 * accessible names, and each link gets a `title` tooltip.
 *
 * `SideNav` reads the path itself; `SideNavView` takes it as a prop so the
 * layout can render it as a Suspense fallback and previews can pin a path.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { Vitonen } from "@/components/vitonen";
import {
  SETTINGS_HREF,
  SIDE_ITEMS,
  courseHref,
  currentCourseId,
  sideCurrent,
  type IconShape,
} from "./nav-items";
import { useSide } from "./use-side";

export type CourseColor = "butter" | "mint" | "sky" | "blush";

export type SideCourse = { id: string; name: string; color: CourseColor };

export type SideUser = {
  /** Her first name, or null when we do not know it yet. */
  firstName: string | null;
  /** School shown under her name, or null. */
  school: string | null;
};

export type SideNavProps = {
  courses: readonly SideCourse[];
  user: SideUser | null;
};

/** A 24x24 stroke icon drawn from `nav-items.ts` shapes. */
export function NavIcon({ shapes, className = "" }: { shapes: readonly IconShape[]; className?: string }) {
  return (
    <svg className={`ic ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      {shapes.map((s, i) =>
        s.kind === "path" ? (
          <path key={i} d={s.d} />
        ) : (
          <circle key={i} cx={s.cx} cy={s.cy} r={s.r} />
        ),
      )}
    </svg>
  );
}

const DOT: Record<CourseColor, string> = {
  butter: "bg-butter",
  mint: "bg-mint",
  sky: "bg-sky",
  blush: "bg-accent-wash",
};

/** Fades out as the rail folds (`--side-c` goes 0 to 1). */
const FADE = "opacity-[calc(1_-_var(--side-c,0))] transition-opacity duration-quick ease-out";

/** Sidebar-panel icon for the fold button. */
const FOLD_ICON: readonly IconShape[] = [
  {
    kind: "path",
    d: "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z",
  },
  { kind: "path", d: "M9.5 4v16" },
];

const ROW =
  "flex h-11 items-center gap-3 rounded-xl border-0 text-ink-2 whitespace-nowrap no-underline " +
  "transition-colors duration-quick ease-out " +
  "[@media(hover:hover)]:hover:bg-surface [@media(hover:hover)]:hover:text-ink " +
  "aria-[current=page]:bg-surface aria-[current=page]:text-ink aria-[current=page]:font-semibold";

export function SideNav(props: SideNavProps) {
  const pathname = usePathname();
  return <SideNavView {...props} pathname={pathname} />;
}

export function SideNavView({
  courses,
  user,
  pathname,
}: SideNavProps & { pathname: string | null }) {
  const current = sideCurrent(pathname);
  const courseId = currentCourseId(pathname);
  const initial = user?.firstName?.charAt(0).toUpperCase() ?? "";
  const sideRef = useRef<HTMLElement>(null);
  const { collapsed, toggle } = useSide(sideRef);
  /** Tooltip for a link whose label is folded away. */
  const tip = (label: string) => (collapsed ? label : undefined);

  return (
    <aside
      ref={sideRef}
      id="side"
      aria-label="Sidebar"
      className="hidden min-h-0 w-[calc(240px_-_168px*var(--side-c,0))] flex-col overflow-hidden border-r border-line bg-paper px-3 py-4 min-[700px]:flex"
    >
      <div className="relative mb-5 flex min-h-11 items-center">
        <Link
          href="/home"
          tabIndex={collapsed ? -1 : undefined}
          aria-hidden={collapsed ? true : undefined}
          className={`flex items-center gap-2 rounded-xl pl-3 font-display text-[22px] font-semibold leading-none whitespace-nowrap text-ink no-underline ${FADE} ${collapsed ? "pointer-events-none" : ""}`}
          style={{ fontVariationSettings: '"SOFT" 100' }}
        >
          <Vitonen size={24} />
          <span>Ready</span>
        </Link>
        {/* Right end of the head when open; the rail's only head item when folded. */}
        <button
          type="button"
          onClick={toggle}
          aria-controls="side"
          aria-expanded={collapsed === null ? undefined : !collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="absolute top-0 left-[calc((1_-_var(--side-c,0))*168px)] grid h-11 w-12 place-items-center rounded-xl border-0 bg-transparent text-ink-2 transition-colors duration-quick ease-out [@media(hover:hover)]:hover:bg-surface [@media(hover:hover)]:hover:text-ink"
        >
          <NavIcon shapes={FOLD_ICON} className="!h-5 !w-5" />
        </button>
      </div>

      <nav aria-label="Main" className="grid gap-0.5">
        {SIDE_ITEMS.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            aria-current={current === item.id ? "page" : undefined}
            title={tip(item.label)}
            className={`${ROW} px-3.5 text-[15px] font-medium`}
          >
            <NavIcon shapes={item.icon} className="!h-5 !w-5" />
            <span className={FADE}>{item.label}</span>
          </Link>
        ))}
      </nav>

      {courses.length > 0 ? (
        <>
          <p
            className={`mono mt-6 mb-1.5 ml-3.5 whitespace-nowrap text-ink-3 ${FADE}`}
            id="side-courses-label"
          >
            COURSES
          </p>
          <ul
            aria-labelledby="side-courses-label"
            className="grid min-h-0 list-none gap-0.5 overflow-y-auto"
          >
            {courses.map((course) => (
              <li key={course.id}>
                <Link
                  href={courseHref(course.id)}
                  title={course.name}
                  aria-current={courseId === course.id ? "page" : undefined}
                  className={`${ROW} px-[19px] text-[13px]`}
                >
                  <i
                    aria-hidden="true"
                    className={`inline-block h-2.5 w-2.5 flex-none rounded-full shadow-[inset_0_0_0_1px_var(--line)] ${DOT[course.color]}`}
                  />
                  <span className={`min-w-0 truncate ${FADE}`}>{course.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="flex-1" />

      {user ? (
        <Link
          href={SETTINGS_HREF}
          aria-current={pathname === SETTINGS_HREF ? "page" : undefined}
          title={tip(user.firstName ?? "Settings")}
          className="flex min-h-11 items-center gap-2.5 rounded-xl px-1.5 py-1 whitespace-nowrap text-ink no-underline transition-colors duration-quick ease-out [@media(hover:hover)]:hover:bg-surface"
        >
          <span
            aria-hidden="true"
            className="grid h-9 w-9 flex-none place-items-center rounded-full bg-accent-wash font-display text-base font-semibold text-ink"
            style={{ fontVariationSettings: '"SOFT" 100' }}
          >
            {initial}
          </span>
          <span className={`min-w-0 ${FADE}`}>
            <span className="block truncate text-[15px] font-semibold">
              {user.firstName ?? "Settings"}
            </span>
            {user.school ? (
              <span className="mono block truncate text-ink-3">{user.school}</span>
            ) : null}
          </span>
        </Link>
      ) : null}
    </aside>
  );
}

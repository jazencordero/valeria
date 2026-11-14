/**
 * The app frame's destinations, their icons and which one is current.
 * Source: prototype merged.html HTML 1621-1644 (sidebar), 1891-1896 (tab bar)
 * and 2026-2035 (More sheet).
 *
 * Kept free of React so the active-state rules are plain functions.
 *
 * Active rules (a path "is under" `/x` when it is `/x` or starts with `/x/`):
 *  - Sidebar: each item is current under its own href. A course is current
 *    under `/courses/<id>`, which covers its lecture pages
 *    (`/courses/<id>/lectures/<n>`).
 *  - Tab bar: Home, Exams and Notes under their own href. Courses under
 *    `/courses` (the list, a course, a lecture). More under `/assignments`,
 *    `/grades` and `/calendar`, the pages the More sheet opens.
 *  - Anything else (for example `/settings`) lights nothing.
 */

/** One shape of a 24x24 stroke icon. */
export type IconShape =
  | { kind: "path"; d: string }
  | { kind: "circle"; cx: number; cy: number; r: number };

export type NavId =
  | "home"
  | "assignments"
  | "exams"
  | "notes"
  | "grades"
  | "calendar"
  | "courses"
  | "more";

export type NavItem = {
  id: NavId;
  label: string;
  href: string;
  icon: IconShape[];
};

const p = (d: string): IconShape => ({ kind: "path", d });
const c = (cx: number, cy: number, r: number): IconShape => ({ kind: "circle", cx, cy, r });

export const ICONS: Record<NavId, IconShape[]> = {
  home: [p("M4.5 11l7.5-6.5 7.5 6.5v8.5h-5v-5.5h-5v5.5h-5z")],
  assignments: [p("M6.5 5.5h11v15h-11z"), p("M9.5 3.5h5v3h-5z"), p("M9.5 12.5l2 2 3.5-3.5")],
  exams: [c(12, 13.5, 7), p("M12 10v3.5l2.5 1.5"), p("M10 3.5h4")],
  notes: [
    p("M5 19l1.2-4.2 9.6-9.6a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8l-9.6 9.6z"),
    p("M14.5 6.5l3 3"),
  ],
  grades: [p("M4 19.5h16M7 19.5v-5M12 19.5v-9M17 19.5v-13")],
  calendar: [p("M4.5 6h15v13.5h-15z"), p("M4.5 10h15M8.5 3.5v4M15.5 3.5v4")],
  courses: [
    p("M12 6.5c-2-1.5-4.5-2-7.5-2v13c3 0 5.5.5 7.5 2 2-1.5 4.5-2 7.5-2v-13c-3 0-5.5.5-7.5 2z"),
    p("M12 6.5v13"),
  ],
  more: [c(6, 12, 1.2), c(12, 12, 1.2), c(18, 12, 1.2)],
};

const item = (id: NavId, label: string, href: string): NavItem => ({
  id,
  label,
  href,
  icon: ICONS[id],
});

const HOME = item("home", "Home", "/home");
const ASSIGNMENTS = item("assignments", "Assignments", "/assignments");
const EXAMS = item("exams", "Exams", "/exams");
const NOTES = item("notes", "Notes", "/notes");
const GRADES = item("grades", "Grades", "/grades");
const CALENDAR = item("calendar", "Calendar", "/calendar");
const COURSES = item("courses", "Courses", "/courses");

/** Sidebar links, in order. Notes is left out until M9-13. */
export const SIDE_ITEMS: readonly NavItem[] = [HOME, ASSIGNMENTS, EXAMS, GRADES, CALENDAR];

/** Tab bar links, in order; More is a button after these. */
export const TAB_ITEMS: readonly NavItem[] = [HOME, COURSES, EXAMS, NOTES];

/** Rows of the More sheet, in order. */
export const MORE_ITEMS: readonly NavItem[] = [ASSIGNMENTS, GRADES, CALENDAR];

export const MORE_LABEL = "More";
export const MORE_ICON = ICONS.more;

export const SETTINGS_HREF = "/settings";

export const courseHref = (id: string) => `/courses/${encodeURIComponent(id)}`;

/** True when `pathname` is `base` or a page below it. */
export function isUnder(pathname: string | null, base: string): boolean {
  if (!pathname) return false;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** The sidebar item to mark current, if any. */
export function sideCurrent(pathname: string | null): NavId | null {
  return SIDE_ITEMS.find((i) => isUnder(pathname, i.href))?.id ?? null;
}

/** The course whose pages are showing (`/courses/<id>/...`), if any. */
export function currentCourseId(pathname: string | null): string | null {
  const match = pathname?.match(/^\/courses\/([^/]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** The tab to light, if any. */
export function tabCurrent(pathname: string | null): NavId | null {
  const tab = TAB_ITEMS.find((i) => isUnder(pathname, i.href));
  if (tab) return tab.id;
  if (MORE_ITEMS.some((i) => isUnder(pathname, i.href))) return "more";
  return null;
}

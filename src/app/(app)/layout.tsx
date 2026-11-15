/**
 * The app frame for every signed-in page (/home, /courses, /exams ...).
 * Source: prototype merged.html CSS 390-394 and 942-944 (.shell, .main).
 *
 * Under 700 px: the page, then the tab bar (Home, Courses, Exams, Notes,
 * More). From 700 px: a 240 px side nav, then the page. The page area
 * scrolls on its own; the frame never scrolls.
 *
 * Her user and courses are read per request (cookie), so the side nav is
 * streamed inside Suspense; the fallback is the same side nav without her
 * courses or chip. The tab bar needs only the path.
 *
 * The side nav folds to a 72 px icon rail (M4-01, logic in
 * `@/components/shell/use-side`). Folded between 700 and 1000 px, open from
 * 1000 px, unless she chose: her choice is in localStorage['ready-side'] and
 * mirrored on <html data-side>. The server cannot read localStorage, so
 * SIDE_BOOT runs before the side nav is parsed and copies the choice onto
 * <html> (which already has suppressHydrationWarning for the theme script).
 * The grid turns that and the width into `--side-c` (1 folded, 0 open), which
 * sizes the side nav in plain CSS: no jump on reload, no hydration mismatch.
 *
 * The page sits inside `PageTransition` (M4-02): switching between sidebar
 * tabs fades the old page out and lifts the new one in, and focus moves to
 * the new heading. The demo line has its own view-transition name so it stays
 * put, above the pages, while they change.
 *
 * Count badges (M4-04): `shellCounts` reads, per request, her open
 * assignments (one query) and upcoming exams (one count). The rules are the
 * tabs' own: open is not handed in (`submitted_at` unset and state not
 * submitted or graded, as `getAssignmentsView`), upcoming is `at >= now`
 * (as `getExamsView`), and hidden courses count for neither. Due today is an
 * open assignment due on today's Helsinki day (`sameDay`). It is wrapped in
 * React `cache`, so the side nav and the tab bar share one load. A hand-in's
 * action calls `refresh()`, which re-renders this layout, so the numbers roll.
 *
 * Notes (M9-13): `shellCounts` also counts her notes (`countNotes`, M9-11)
 * for the sidebar's Notes item; the notepad's actions call `refresh()` when a
 * note is created or deleted. The notepad itself (floating button and drawer)
 * is mounted once here, outside the grid: it is fixed to the viewport, reads
 * the path on its own and hides itself during a study session (`/study/...`).
 * It sits in its own Suspense because it reads the path.
 *
 * A demo user (M1-37, `users.settings.demo`) gets a thin "Demo data" line at
 * the top of the page area, with "Restart demo" (GET /demo?reset=1).
 */
import { asc, and, count, eq, gte, inArray, isNull, not } from "drizzle-orm";
import { connection } from "next/server";
import { cache, Suspense, type ReactNode } from "react";
import { Notepad } from "@/components/notes/notepad";
import { PageTransition } from "@/components/shell/page-transition";
import {
  SideNav,
  SideNavView,
  type SideCounts,
  type SideCourse,
  type SideUser,
} from "@/components/shell/side-nav";
import { TabBar, TabBarView } from "@/components/shell/tab-bar";
import { sameDay } from "@/lib/dates";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { exams } from "@/server/db/schema/study";
import { assignments } from "@/server/db/schema/work";
import { countNotes } from "@/server/notes/store";

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

function firstName(displayName: string | null): string | null {
  const first = displayName?.trim().split(/\s+/)[0];
  return first ? first : null;
}

type ShellCounts = SideCounts & { dueToday: number };

/** The badge counts for one user, read once per request. */
const shellCounts = cache(async (userId: string): Promise<ShellCounts> => {
  const now = new Date();
  const [open, [upcoming], notes] = await Promise.all([
    db
      .select({ dueAt: assignments.dueAt })
      .from(assignments)
      .innerJoin(courses, eq(courses.id, assignments.courseId))
      .where(
        and(
          eq(assignments.userId, userId),
          eq(courses.userId, userId),
          eq(courses.hidden, false),
          isNull(assignments.submittedAt),
          not(inArray(assignments.state, ["submitted", "graded"])),
        ),
      ),
    db
      .select({ n: count() })
      .from(exams)
      .innerJoin(courses, eq(courses.id, exams.courseId))
      .where(
        and(
          eq(exams.userId, userId),
          eq(courses.userId, userId),
          eq(courses.hidden, false),
          gte(exams.at, now),
        ),
      ),
    countNotes(userId),
  ]);
  return {
    assignments: open.length,
    exams: upcoming?.n ?? 0,
    notes,
    dueToday: open.filter((a) => a.dueAt !== null && sameDay(a.dueAt, now)).length,
  };
});

async function SideNavForUser() {
  // Per-request from here on (session check uses the current time).
  await connection();
  const user = await signedInUser();
  const [rows, counts]: [SideCourse[], ShellCounts] = await Promise.all([
    db
      .select({ id: courses.id, name: courses.name, color: courses.color })
      .from(courses)
      .where(and(eq(courses.userId, user.id), eq(courses.hidden, false)))
      .orderBy(asc(courses.name)),
    shellCounts(user.id),
  ]);
  const chip: SideUser = { firstName: firstName(user.displayName), school: user.school };
  return <SideNav courses={rows} user={chip} counts={counts} />;
}

async function TabBarForUser() {
  await connection();
  const user = await signedInUser();
  const { dueToday } = await shellCounts(user.id);
  return <TabBar dueToday={dueToday} />;
}

async function DemoBanner() {
  await connection();
  const user = await signedInUser();
  // Same check as `isDemo` in @/server/demo/seed, written out so the shell does not load the seed code.
  if (user.settings?.demo !== true) return null;
  return (
    <p
      className="sticky top-0 z-10 m-0 flex items-center justify-center gap-3 border-b border-line bg-butter px-4 py-1 text-[12px] font-medium text-ink"
      style={{ viewTransitionName: "demo-banner" }}
    >
      <span>Demo data</span>
      {/* A route handler, not a page: a plain link, so no prefetch runs the reset. */}
      <a href="/demo?reset=1" className="text-ink-2 underline underline-offset-2">
        Restart demo
      </a>
    </p>
  );
}

// Same key as SIDE_KEY in @/components/shell/use-side (a client module, so
// its exports cannot be read here).
const SIDE_BOOT = `try{var s=localStorage.getItem('ready-side');if(s==='collapsed'||s==='expanded')document.documentElement.setAttribute('data-side',s)}catch(e){}`;

/** `--side-c`: 1 folded, 0 open. Her choice on <html> beats the width default. */
const SIDE_VAR =
  "[--side-c:0] max-[1000px]:[--side-c:1] " +
  "[html[data-side=collapsed]_&]:[--side-c:1] [html[data-side=expanded]_&]:[--side-c:0]";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: SIDE_BOOT }} />
      <div
        className={`${SIDE_VAR} grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-surface min-[700px]:grid-cols-[auto_minmax(0,1fr)] min-[700px]:grid-rows-[minmax(0,1fr)] min-[700px]:bg-paper`}
      >
        <Suspense fallback={<SideNavView courses={[]} user={null} pathname={null} />}>
          <SideNavForUser />
        </Suspense>
        <main
          id="main"
          className="relative min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-surface [container-type:inline-size]"
        >
          <Suspense fallback={null}>
            <DemoBanner />
          </Suspense>
          <PageTransition>{children}</PageTransition>
        </main>
        <Suspense fallback={<TabBarView pathname={null} />}>
          <TabBarForUser />
        </Suspense>
      </div>
      <Suspense fallback={null}>
        <Notepad />
      </Suspense>
    </>
  );
}

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
 * A demo user (M1-37, `users.settings.demo`) gets a thin "Demo data" line at
 * the top of the page area, with "Restart demo" (GET /demo?reset=1).
 */
import { asc, and, eq } from "drizzle-orm";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { SideNav, SideNavView, type SideCourse, type SideUser } from "@/components/shell/side-nav";
import { TabBar, TabBarView } from "@/components/shell/tab-bar";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";

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

async function SideNavForUser() {
  // Per-request from here on (session check uses the current time).
  await connection();
  const user = await signedInUser();
  const rows: SideCourse[] = await db
    .select({ id: courses.id, name: courses.name, color: courses.color })
    .from(courses)
    .where(and(eq(courses.userId, user.id), eq(courses.hidden, false)))
    .orderBy(asc(courses.name));
  const chip: SideUser = { firstName: firstName(user.displayName), school: user.school };
  return <SideNav courses={rows} user={chip} />;
}

async function DemoBanner() {
  await connection();
  const user = await signedInUser();
  // Same check as `isDemo` in @/server/demo/seed, written out so the shell does not load the seed code.
  if (user.settings?.demo !== true) return null;
  return (
    <p className="sticky top-0 z-10 m-0 flex items-center justify-center gap-3 border-b border-line bg-butter px-4 py-1 text-[12px] font-medium text-ink">
      <span>Demo data</span>
      {/* A route handler, not a page: a plain link, so no prefetch runs the reset. */}
      <a href="/demo?reset=1" className="text-ink-2 underline underline-offset-2">
        Restart demo
      </a>
    </p>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-surface min-[700px]:grid-cols-[auto_minmax(0,1fr)] min-[700px]:grid-rows-[minmax(0,1fr)] min-[700px]:bg-paper">
      <Suspense fallback={<SideNavView courses={[]} user={null} pathname={null} />}>
        <SideNavForUser />
      </Suspense>
      <main className="relative min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-surface [container-type:inline-size]">
        <Suspense fallback={null}>
          <DemoBanner />
        </Suspense>
        {children}
      </main>
      <Suspense fallback={<TabBarView pathname={null} />}>
        <TabBar />
      </Suspense>
    </div>
  );
}

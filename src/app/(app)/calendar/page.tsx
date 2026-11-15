/**
 * Calendar tab (M4-09): deadlines and exams by day for the next six weeks.
 * Source: prototype main-flow.html HTML 1603-1619 (#tab-cal) and CSS 770-813
 * (.page, .page-sub, .cal-list, .cal-day, .cal-date, .cal-item, .cal-gap).
 *
 * Rows come from `calendarRows` (src/lib/home/calendar-list.ts). This page
 * reads our database only:
 * - Deadlines: her assignments in visible courses with a due date, not handed
 *   in (`submitted_at` set, or `state` submitted or graded, are left out:
 *   they are no longer due, and the Assignments tab lists them as done).
 * - Exams and quizzes: her `exams` rows in visible courses (the sync adds one
 *   per exam or quiz date). Calendar events with no exam row (a deleted
 *   suggestion, "other" dates) are left out: there is nothing to open.
 *
 * The heading ships in the static shell; the LMS line and the list depend on
 * the cookie, so they stream inside Suspense. Cut: a list, not a month grid.
 */
import { and, eq, gte, isNotNull, isNull, lt, notInArray } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { calendarRows, CALENDAR_DAYS, type CalendarItem, type CourseColor } from "@/lib/home/calendar-list";
import { lmsNameOf } from "@/lib/schools";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { shortNameOf } from "@/server/data/courses";
import { db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { exams } from "@/server/db/schema/study";
import { assignments } from "@/server/db/schema/work";

const DAY_MS = 24 * 60 * 60 * 1000;

const DOT: Record<CourseColor, string> = {
  butter: "bg-butter",
  mint: "bg-mint",
  sky: "bg-sky",
  blush: "bg-accent-wash",
};

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

/** Her deadlines and exams around the window; `calendarRows` cuts it to the exact days. */
async function calendarItems(userId: string, now: Date): Promise<CalendarItem[]> {
  // A day either side covers any Helsinki day boundary.
  const from = new Date(now.getTime() - DAY_MS);
  const to = new Date(now.getTime() + (CALENDAR_DAYS + 1) * DAY_MS);

  const [due, tests] = await Promise.all([
    db
      .select({
        id: assignments.id,
        title: assignments.name,
        at: assignments.dueAt,
        course: courses.name,
        color: courses.color,
      })
      .from(assignments)
      .innerJoin(courses, eq(courses.id, assignments.courseId))
      .where(
        and(
          eq(assignments.userId, userId),
          eq(courses.userId, userId),
          eq(courses.hidden, false),
          isNotNull(assignments.dueAt),
          gte(assignments.dueAt, from),
          lt(assignments.dueAt, to),
          isNull(assignments.submittedAt),
          notInArray(assignments.state, ["submitted", "graded"]),
        ),
      ),
    db
      .select({
        id: exams.id,
        kind: exams.kind,
        title: exams.title,
        at: exams.at,
        course: courses.name,
        color: courses.color,
      })
      .from(exams)
      .innerJoin(courses, eq(courses.id, exams.courseId))
      .where(
        and(
          eq(exams.userId, userId),
          eq(courses.userId, userId),
          eq(courses.hidden, false),
          gte(exams.at, from),
          lt(exams.at, to),
        ),
      ),
  ]);

  return [
    ...due.map((a) => ({
      id: a.id,
      kind: "deadline" as const,
      title: a.title,
      course: shortNameOf(a.course),
      color: a.color,
      at: a.at as Date,
    })),
    ...tests.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      course: shortNameOf(e.course),
      color: e.color,
      at: e.at,
    })),
  ];
}

async function CalendarList() {
  await connection();
  const user = await signedInUser();
  const now = new Date();
  const rows = calendarRows(await calendarItems(user.id, now), now);

  return (
    <>
      <p className="mt-1.5 text-[15px] text-ink-2">Deadlines and exams from {lmsNameOf(user)}.</p>
      <ol className="mt-5 list-none">
        {rows.map((row) =>
          row.type === "gap" ? (
            <li key={row.key} className="mono border-t border-dashed border-line py-2.5 text-ink-3">
              {row.label}
            </li>
          ) : (
            <li key={row.key} className="border-t border-solid border-line py-3.5">
              <p className="mono text-ink-2">{row.label}</p>
              {row.items.map((item) => (
                <Link
                  key={`${item.kind}-${item.id}`}
                  href={item.href}
                  className="mt-2 flex items-start gap-3 rounded-lg text-ink no-underline [@media(hover:hover)]:hover:text-ink-2"
                >
                  <i
                    aria-hidden="true"
                    className={`mt-1.5 inline-block h-2.5 w-2.5 flex-none rounded-full shadow-[inset_0_0_0_1px_var(--line)] ${DOT[item.color]}`}
                  />
                  <span className="min-w-0">
                    <span className="block text-[15px] font-medium [overflow-wrap:anywhere]">{item.title}</span>
                    <span className="block text-[13px] text-ink-3">{item.meta}</span>
                  </span>
                </Link>
              ))}
            </li>
          ),
        )}
      </ol>
    </>
  );
}

export default function CalendarPage() {
  return (
    <div className="mx-auto max-w-[720px] px-[var(--pad)] pt-[max(20px,env(safe-area-inset-top,0px))] pb-10">
      <h1 className="type-h30" tabIndex={-1}>
        Calendar
      </h1>
      <Suspense fallback={null}>
        <CalendarList />
      </Suspense>
    </div>
  );
}

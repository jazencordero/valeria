/**
 * Courses tab (M9-08): one card per visible course with its lecture progress.
 * Source: prototype merged.html HTML 1859-1866 (#tab-courses), JS 5291-5300
 * (renderCourseList) and CSS 997-1004 (.courses-list, .ccard).
 *
 * The heading ships in the static shell; the count line and the cards depend
 * on the cookie, so they stream inside Suspense.
 */
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { currentUser, ensureSession, NotSignedIn, type User } from "@/server/auth/session";
import { getCoursesList, type CourseCard } from "@/server/data/courses";

async function signedInUser(): Promise<User> {
  try {
    return await currentUser();
  } catch (err) {
    // First visit: the proxy has set the cookie but no user row exists yet.
    if (err instanceof NotSignedIn) return ensureSession();
    throw err;
  }
}

const DOT: Record<CourseCard["color"], string> = {
  butter: "bg-butter",
  mint: "bg-mint",
  sky: "bg-sky",
  blush: "bg-accent-wash",
};

function Card({ course }: { course: CourseCard }) {
  return (
    <Link
      href={course.href}
      className={
        "relative grid w-full gap-1 rounded-[20px] border border-line bg-surface px-[18px] py-4 text-left text-ink no-underline " +
        "shadow-[var(--shadow-card)] transition-[transform,box-shadow] duration-quick ease-out " +
        "hover:-translate-y-0.5 hover:shadow-[var(--shadow-lift)] motion-reduce:hover:translate-y-0"
      }
    >
      <span className="flex items-center gap-2.5">
        <i
          aria-hidden="true"
          className={`inline-block h-2.5 w-2.5 flex-none rounded-full shadow-[inset_0_0_0_1px_var(--line)] ${DOT[course.color]}`}
        />
        <span className="font-display text-[18px] leading-[1.2] font-semibold [font-variation-settings:'SOFT'_100]">
          {course.short}
        </span>
      </span>
      {course.code ? <span className="mono pl-5 text-ink-3">{course.code}</span> : null}
      <span className="mt-2 flex justify-between gap-3 text-ink-2">
        <span className="mono">{course.lectureLine}</span>
        {course.readLine ? <span className="mono">{course.readLine}</span> : null}
      </span>
      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${(course.progress * 100).toFixed(1)}%` }} />
      </span>
    </Link>
  );
}

async function CourseCards() {
  await connection();
  const user = await signedInUser();
  const list = await getCoursesList(user.id, { now: new Date() });
  return (
    <>
      <p className="mt-1.5 text-[15px] text-ink-2">{list.line}</p>
      {list.courses.length > 0 ? (
        <ul className="mt-5 grid list-none gap-3">
          {list.courses.map((c) => (
            <li key={c.id}>
              <Card course={c} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export default function CoursesPage() {
  return (
    <div className="mx-auto max-w-[720px] px-[var(--pad)] pt-[max(20px,env(safe-area-inset-top,0px))] pb-10">
      <h1 className="type-h30" tabIndex={-1}>
        Courses
      </h1>
      <Suspense fallback={null}>
        <CourseCards />
      </Suspense>
    </div>
  );
}

"use client";

/**
 * One course (M9-08): sticky head with "Back to courses" (phones) and the
 * code, the course name with its dot, stat chips and the path.
 * Source: prototype merged.html JS 5326-5357 (coursePageHTML) and CSS
 * 604-606 (.ep-head), 1006-1009 (.cp-h1, .cp-stats, .cp-stat).
 *
 * Plain data in (`CoursePage` from src/server/data/courses.ts); no fetching.
 * A stop or its label opens that lecture; a not-posted stop goes nowhere. The
 * finish flag opens the exam. A course where no lectures were recognised
 * shows its files as a plain list instead of the path.
 *
 * Cut: the grade chip waits for M6-08.
 */
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { CoursePath, type CoursePathLecture } from "@/components/courses/course-path";
import { Button } from "@/components/ui/button";
import { StickyHeader } from "@/components/ui/sticky-header";
import type { CoursePage as CoursePageData } from "@/server/data/courses";

type CourseColor = CoursePageData["color"];

const DOT: Record<CourseColor, string> = {
  butter: "bg-butter",
  mint: "bg-mint",
  sky: "bg-sky",
  blush: "bg-accent-wash",
};

export type CoursePageProps = {
  course: CoursePageData;
  /** Where "Back to courses" goes. */
  backHref?: string;
  /** The school's LMS name, for the line shown when a course has no files at all. */
  lmsName: string;
};

export function CoursePage({ course, backHref = "/courses", lmsName }: CoursePageProps) {
  const router = useRouter();
  const path = course.path;

  const openLecture = useCallback(
    (l: CoursePathLecture) => {
      if (l.state === "soon") return;
      const target = path?.lectures.find((x) => x.n === l.n);
      if (target) router.push(target.href);
    },
    [path, router],
  );
  const openExam = useCallback(() => {
    if (path?.finish.href) router.push(path.finish.href);
  }, [path, router]);

  return (
    <div className="mx-auto max-w-[720px] px-[var(--pad)] pb-10">
      <StickyHeader
        padTop="4px"
        className="-mx-[var(--pad)] flex min-h-[52px] items-center gap-1 pr-[var(--pad)] pb-1 pl-[calc(var(--pad)-12px)] min-[700px]:pl-[var(--pad)]"
      >
        <Button variant="icon" href={backHref} aria-label="Back to courses" className="min-[700px]:hidden">
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14.5 5.5L8 12l6.5 6.5" />
          </svg>
        </Button>
        {course.code ? <p className="mono text-ink-3">{course.code}</p> : null}
      </StickyHeader>

      <h1 tabIndex={-1} className="type-h30 mt-1 flex items-center gap-3 outline-none">
        <i
          aria-hidden="true"
          className={`inline-block h-3.5 w-3.5 flex-none rounded-full shadow-[inset_0_0_0_1px_var(--line)] ${DOT[course.color]}`}
        />
        <span className="min-w-0">{course.name}</span>
      </h1>

      {course.stats.length > 0 ? (
        <div className="mt-3.5 flex flex-wrap gap-2">
          {course.stats.map((s) => (
            <span
              key={s}
              className="mono rounded-full border border-line bg-paper px-2.5 py-1 whitespace-nowrap text-ink-2"
            >
              {s}
            </span>
          ))}
        </div>
      ) : null}

      {path ? (
        <CoursePath
          className="mt-6"
          lectures={path.lectures}
          flags={path.flags}
          finish={path.finish}
          onStopClick={openLecture}
          onFinishClick={path.finish.href ? openExam : undefined}
        />
      ) : course.files.length > 0 ? (
        <section className="mt-6">
          <p className="text-[15px] text-ink-2">Ready could not tell which of these are lectures.</p>
          <ul className="mt-3 list-none border-t border-line">
            {course.files.map((f) => (
              <li key={f.id} className="flex items-baseline justify-between gap-3 border-b border-line py-2.5">
                <span className="min-w-0 text-[15px] [overflow-wrap:anywhere]">{f.name}</span>
                {f.section ? <span className="mono flex-none text-ink-3">{f.section}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="mt-6 text-[15px] text-ink-2">No files from {lmsName} for this course yet.</p>
      )}
    </div>
  );
}

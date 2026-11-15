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
 * A lecture grows out of its stop as a circle (420 ms) and its Back shrinks
 * it into the stop again (380 ms), with the path's scroll put back (M9-18,
 * `LECTURE_PAGE` in `@/lib/motion/shared`; calm: a fade, no View
 * Transitions or a page that is not there yet: a slide). Only once that close
 * is over does the path's advance play, when the lecture was marked read on
 * that visit (`cardClosed`; the lecture page leaves `{ lectureRead: n }`). A stop's
 * page is prefetched when it is hovered or pressed, and the current one on
 * arrival, so the circle has its page in time.
 *
 * Cut: the grade chip waits for M6-08.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { CoursePath, type CoursePathHandle, type CoursePathLecture } from "@/components/courses/course-path";
import { Button } from "@/components/ui/button";
import { StickyHeader } from "@/components/ui/sticky-header";
import { LECTURE_PAGE, WORK_TRANSITION_CSS, cardClosed, openCardPage } from "@/lib/motion/shared";
import { useMotionMode } from "@/lib/motion/use-calm";
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

/** The lecture `n` the close came back from, when it was marked read on that visit (the lecture page's `detail`). */
export function readOnClose(detail: unknown): number | null {
  if (typeof detail !== "object" || detail === null) return null;
  const n = (detail as { lectureRead?: unknown }).lectureRead;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

export function CoursePage({ course, backHref = "/courses", lmsName }: CoursePageProps) {
  const router = useRouter();
  const mode = useMotionMode();
  const path = course.path;
  const pathRef = useRef<CoursePathHandle>(null);

  // Back from a lecture read just now: the advance plays once the lecture has shrunk into its stop.
  const lectures = path?.lectures;
  const latest = useRef(lectures);
  useEffect(() => {
    latest.current = lectures;
  }, [lectures]);
  useEffect(() => {
    let live = true;
    void cardClosed().then((c) => {
      const n = c ? readOnClose(c.detail) : null;
      const lectures = latest.current;
      if (!live || n === null || !lectures) return;
      // Only when this page already shows it read (it is fetched again after the read).
      if (lectures.find((l) => l.n === n)?.state !== "done") return;
      pathRef.current?.playAdvance({ from: n, to: lectures.find((l) => l.state === "cur")?.n ?? null });
    });
    return () => {
      live = false;
    };
  }, []);

  // The stop she is most likely to tap: its page is fetched ahead.
  useEffect(() => {
    const cur = lectures?.find((l) => l.state === "cur");
    if (cur) router.prefetch(cur.href);
  }, [lectures, router]);

  const openLecture = useCallback(
    (l: CoursePathLecture, stop: HTMLElement) => {
      if (l.state === "soon") return;
      const target = path?.lectures.find((x) => x.n === l.n);
      if (!target) return;
      openCardPage(stop, mode, () => router.push(target.href), LECTURE_PAGE, target.href);
    },
    [mode, path, router],
  );
  const prefetchLecture = useCallback(
    (l: CoursePathLecture) => {
      if (l.state === "soon") return;
      const target = path?.lectures.find((x) => x.n === l.n);
      if (target) router.prefetch(target.href);
    },
    [path, router],
  );
  const openExam = useCallback(() => {
    if (path?.finish.href) router.push(path.finish.href);
  }, [path, router]);

  return (
    <div className="mx-auto max-w-[720px] px-[var(--pad)] pb-10">
      <style href="ready-work-transition" precedence="default">
        {WORK_TRANSITION_CSS}
      </style>
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
          ref={pathRef}
          className="mt-6"
          lectures={path.lectures}
          flags={path.flags}
          finish={path.finish}
          onStopClick={openLecture}
          onStopPress={prefetchLecture}
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

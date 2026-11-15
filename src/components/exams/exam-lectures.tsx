/**
 * Exam page, Lectures tab (M9-23).
 * Source: prototype merged-2.html JS 6049-6062 (lecturesHTML) and CSS
 * 1462-1474 (.xl-top, .xl-list, .xl-row, .xl-num, .xl-main).
 *
 * "Continue lecture N" (the course's current lecture, when there is one) and
 * "See the whole course path" (the course page), then one row per lecture:
 * a numbered circle (a check when read, an accent ring when current, dashed
 * when not posted), "Lecture 5 · Sourcing and vendors", its concepts, and
 * "6 min read · read / you are here / not read yet" or "opens Mon 16 Nov".
 *
 * A row opens the lecture with `?from=exam:<id>`, so its Back returns to
 * this page; the tab itself is remembered per exam (`Tabs`' memory), so it
 * is the Lectures tab that shows again.
 *
 * Plain data in, no fetching.
 * Cut: the grow-from-the-circle transition (M9-18 is not done); a plain
 * page change.
 */
import Link from "next/link";
import { Button } from "@/components/ui/button";

export type ExamLectureState = "done" | "cur" | "up" | "soon";

export type ExamLectureRow = {
  n: number;
  title: string;
  /** "Demand curves, Elasticity"; "" when no concept is tied to it. */
  concepts: string;
  /** Reading time; null until the lecture page is written. */
  minutes: number | null;
  state: ExamLectureState;
  /** Not posted yet: "Mon 16 Nov". */
  opensOn: string | null;
  /** The lecture page, without the query. */
  href: string;
};

export type ExamLectures = {
  courseId: string;
  /** The course's current lecture, for "Continue lecture N". */
  current: { n: number; href: string } | null;
  rows: ExamLectureRow[];
};

/** The lecture page, opened from this exam: its Back comes here. */
export const fromExam = (href: string, examId: string) => `${href}?from=exam:${encodeURIComponent(examId)}`;

export function stateWords(row: Pick<ExamLectureRow, "state" | "opensOn">): string {
  switch (row.state) {
    case "done":
      return "read";
    case "cur":
      return "you are here";
    case "up":
      return "not read yet";
    case "soon":
      return row.opensOn ? `opens ${row.opensOn}` : "opens soon";
  }
}

/** "6 min read · you are here"; a lecture not posted yet only says when it opens. */
export function metaLine(row: Pick<ExamLectureRow, "state" | "opensOn" | "minutes">): string {
  const words = stateWords(row);
  return row.state === "soon" || row.minutes == null ? words : `${row.minutes} min read · ${words}`;
}

const NUM: Record<ExamLectureState, string> = {
  done: "border-accent bg-accent text-[var(--accent-ink)]",
  cur: "border-transparent bg-surface text-ink shadow-[inset_0_0_0_3px_var(--accent)]",
  up: "border-line bg-surface text-ink-2",
  soon: "border-2 border-dashed border-ink-3 bg-paper text-ink-3",
};

function Num({ row }: { row: ExamLectureRow }) {
  return (
    <span
      aria-hidden="true"
      data-state={row.state}
      className={
        "grid size-11 place-items-center rounded-full border-[1.5px] border-solid font-mono text-[14px] " +
        NUM[row.state]
      }
    >
      {row.state === "done" ? (
        <svg className="ic size-5! [stroke-width:2.4]" viewBox="0 0 24 24" focusable="false">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      ) : (
        row.n
      )}
    </span>
  );
}

export function ExamLecturesTab({ examId, lectures }: { examId: string; lectures: ExamLectures }) {
  const { current, rows, courseId } = lectures;
  return (
    <div className="grid gap-4" data-testid="exam-lectures">
      <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2">
        {current && (
          <Button variant="primary" href={fromExam(current.href, examId)}>
            Continue lecture {current.n}
          </Button>
        )}
        <Link
          href={`/courses/${encodeURIComponent(courseId)}`}
          className={
            "inline-flex min-h-11 items-center text-[15px] font-semibold text-ink underline decoration-line " +
            "decoration-2 underline-offset-[5px] transition-[text-decoration-color] duration-quick ease-out hover:decoration-accent"
          }
        >
          See the whole course path
        </Link>
      </div>
      {rows.length > 0 && (
        <ul className="border-t border-solid border-line">
          {rows.map((row) => (
            <li key={row.n}>
              <Link
                href={fromExam(row.href, examId)}
                data-lec={row.n}
                className={
                  "grid min-h-[72px] w-full grid-cols-[44px_minmax(0,1fr)_20px] items-center gap-x-3.5 " +
                  "border-b border-solid border-line py-2.5 text-left text-ink"
                }
              >
                <Num row={row} />
                <span className="grid min-w-0 gap-0.5">
                  <span className="text-[15px] font-semibold">
                    Lecture {row.n} · {row.title}
                  </span>
                  {row.concepts && <span className="text-[13px] text-ink-2">{row.concepts}</span>}
                  <span className="mono text-[11px] text-ink-3">{metaLine(row)}</span>
                </span>
                <svg className="ic size-5! text-ink-3" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M9.5 5.5L16 12l-6.5 6.5" />
                </svg>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

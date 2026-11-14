"use client";

/**
 * Brief: the assignment brief from Moodle, in the app's type styles.
 *
 * Takes HTML that has already been through `cleanBrief` (server side; the
 * `CleanHtml` type only comes from there). Long briefs are cut to about
 * eight lines with a fade and a "Show all" button; short ones show whole
 * and get no button. Wide tables scroll inside their own box.
 *
 * When pictures or embeds were dropped, a line says so and links to the
 * assignment in the school's LMS (`lmsName`, from `src/lib/schools.ts`).
 */
import { useEffect, useId, useRef, useState, type FocusEvent } from "react";
import { Button } from "@/components/ui/button";
import type { CleanBrief } from "@/lib/html/clean";

export type BriefProps = {
  brief: CleanBrief;
  /** The school's LMS name, for example "MyCourses". */
  lmsName: string;
  /** The assignment page in the LMS. Needed for the "see pictures" link. */
  sourceUrl?: string;
  /** Start expanded (preview pages). */
  defaultExpanded?: boolean;
  className?: string;
};

/** Collapsed height: 8 lines of body text (15 px at 1.45). */
const COLLAPSED = "max-h-[11.6em]";

/** Type styles for the cleaned HTML, matching the app's body and headings. */
const PROSE = [
  "text-[15px] leading-[1.45] text-ink break-words",
  "[&>*+*]:mt-3",
  "[&_h3]:font-display [&_h3]:text-[19px] [&_h3]:leading-[1.25] [&_h3]:tracking-[-0.01em] [&_h3]:font-semibold [&_h3]:mt-5 [&_h3:first-child]:mt-0",
  "[&_h4]:font-display [&_h4]:text-[16px] [&_h4]:font-semibold [&_h4]:mt-4 [&_h4:first-child]:mt-0",
  "[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li+li]:mt-1 [&_li>ul]:mt-1 [&_li>ol]:mt-1",
  "[&_li]:marker:text-ink-3",
  "[&_a]:text-ink [&_a]:underline [&_a]:decoration-ink-3 [&_a]:underline-offset-2 [&_a:hover]:decoration-ink",
  "[&_strong]:font-semibold [&_b]:font-semibold",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-ink-2",
  "[&_hr]:border-0 [&_hr]:border-t [&_hr]:border-line",
  "[&_code]:font-mono [&_code]:text-[13px] [&_code]:bg-paper [&_code]:rounded [&_code]:px-1 [&_code]:py-px",
  "[&_pre]:bg-paper [&_pre]:rounded-xl [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:max-w-full",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  // Tables become their own scroll box so a wide one never widens the page.
  "[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-[14px]",
  "[&_caption]:text-left [&_caption]:text-ink-3 [&_caption]:pb-1",
  "[&_th]:text-left [&_th]:font-semibold [&_th]:align-bottom [&_td]:align-top",
  "[&_th]:border-b [&_th]:border-line [&_td]:border-b [&_td]:border-line",
  "[&_th]:min-w-[6rem] [&_td]:min-w-[6rem] [&_th]:px-3 [&_th]:py-2 [&_td]:px-3 [&_td]:py-2 [&_th:first-child]:pl-0 [&_td:first-child]:pl-0",
].join(" ");

const FADE = "[mask-image:linear-gradient(to_bottom,black_60%,transparent)]";

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function Brief({ brief, lmsName, sourceUrl, defaultExpanded = false, className = "" }: BriefProps) {
  const id = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Whether the full brief is taller than the collapsed box. Measured, so
  // short briefs never get a pointless button.
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const body = bodyRef.current;
    const inner = body?.firstElementChild;
    if (!body || !inner) return;
    const measure = () => {
      // Compare the content height with the collapsed limit, whatever the state.
      const limit = parseFloat(getComputedStyle(body).fontSize) * 11.6;
      setOverflows(inner.getBoundingClientRect().height > limit + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const collapsed = overflows && !expanded;

  // A keyboard user tabbing into a hidden link opens the brief so focus stays visible.
  function onFocus(event: FocusEvent<HTMLDivElement>) {
    if (!collapsed) return;
    const body = bodyRef.current;
    const inner = body?.firstElementChild;
    if (!body || !inner) return;
    // The browser may already have scrolled the clipped box to the target,
    // so measure from the top of the content, not the viewport.
    const bottom = event.target.getBoundingClientRect().bottom - inner.getBoundingClientRect().top;
    body.scrollTop = 0;
    if (bottom > body.clientHeight) setExpanded(true);
  }

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (!next) {
      // Collapsing a long brief can leave the reader far below it.
      const box = bodyRef.current?.getBoundingClientRect();
      if (box && box.top < 0) bodyRef.current?.scrollIntoView({ block: "start" });
    }
  }

  return (
    <section className={`min-w-0 ${className}`} aria-label="Assignment brief">
      <div
        ref={bodyRef}
        id={id}
        onFocus={onFocus}
        className={collapsed ? `relative overflow-hidden ${COLLAPSED} ${FADE}` : "relative"}
      >
        <div className={PROSE} dangerouslySetInnerHTML={{ __html: brief.html }} />
      </div>

      {overflows && (
        <Button
          variant="text"
          size="sm"
          className="-ml-4 mt-1"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={toggle}
        >
          {expanded ? "Show less" : "Show all"}
        </Button>
      )}

      {brief.droppedMedia && (
        <p className="fine mt-3">
          {isHttpUrl(sourceUrl) ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink-2 underline decoration-ink-3 underline-offset-2 hover:text-ink"
            >
              Open in {lmsName} to see pictures
            </a>
          ) : (
            <>Open in {lmsName} to see pictures</>
          )}
        </p>
      )}
    </section>
  );
}

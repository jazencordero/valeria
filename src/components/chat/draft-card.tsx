"use client";

/**
 * Draft card (M2-19). Source: prototype main-flow.html JS 4258-4265 (docHTML),
 * 4417-4431 (showCard) and CSS 885-899 (.doc, .doc-head, .doc-outline, .sk,
 * .doc-toc, .doc-preview, .doc-actions).
 *
 * A file-style card for the draft the chat wrote: "<Title>.pdf", a page
 * estimate and "draft"; an outline; "Read it" / "Hide" for the full text; and
 * "Hand in".
 *
 * Three states, all from plain props (the card fetches nothing):
 * - skeleton: no `markdown` yet. The outline is three pulsing lines and both
 *   buttons are off.
 * - outline: `markdown` is there. The outline is the draft's headings.
 * - expanded: after "Read it". The full text shows under the outline; the
 *   button reads "Hide".
 *
 * She cannot edit the text here; she asks the chat to change it. The text is
 * rendered as React text, never as HTML.
 */
import { motion } from "motion/react";
import { Fragment, useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { calmDuration, duration, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";
import { parseInline, parseMarkdown, type Block, type Inline } from "./message";

/** Characters counted as one page of the draft. */
export const CHARS_PER_PAGE = 3_000;

/** "Assignment 3: Forecasting" becomes "Assignment_3_Forecasting.pdf". */
export function draftFileName(title: string): string {
  const base = title
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .trim()
    .replace(/\s+/g, "_");
  return `${base || "Draft"}.pdf`;
}

/** How many pages the draft comes to, at least 1. An estimate. */
export function draftPages(markdown: string): number {
  return Math.max(1, Math.ceil(markdown.trim().length / CHARS_PER_PAGE));
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

export type DraftHeading = { level: number; text: string };

const plain = (src: string) => parseInline(src).map((span) => span.text).join("");

/** The draft's headings, in order. */
export function draftHeadings(markdown: string): DraftHeading[] {
  const out: DraftHeading[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = HEADING.exec(line);
    if (m && m[2]) out.push({ level: m[1].length, text: plain(m[2]) });
  }
  return out;
}

type Section = { heading?: string; blocks: Block[] };

/** The draft as sections: a heading (none for text before the first one) and what is under it. */
export function draftSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let heading: string | undefined;
  let body: string[] = [];
  const flush = () => {
    const blocks = parseMarkdown(body.join("\n"));
    if (heading !== undefined || blocks.length) sections.push({ heading, blocks });
    body = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    const m = HEADING.exec(line);
    if (m && m[2]) {
      flush();
      heading = plain(m[2]);
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

function StackIcon() {
  return (
    <svg className="ic size-5" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 3.5h7L19 7.5v10H8z" />
      <path d="M15 3.5v4h4" />
      <path d="M5 7v13.5h10" />
    </svg>
  );
}

function Spans({ spans }: { spans: readonly Inline[] }) {
  return (
    <>
      {spans.map((span, i) =>
        span.code ? (
          <code key={i} className="mono-in">
            {span.text}
          </code>
        ) : span.bold ? (
          <strong key={i} className="font-semibold text-ink">
            {span.text}
          </strong>
        ) : (
          <Fragment key={i}>{span.text}</Fragment>
        ),
      )}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.type === "p") {
    return (
      <p>
        <Spans spans={block.spans} />
      </p>
    );
  }
  if (block.type === "list") {
    const List = block.ordered ? "ol" : "ul";
    return (
      <List className={`grid gap-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
        {block.items.map((item, i) => (
          <li key={i}>
            <Spans spans={item} />
          </li>
        ))}
      </List>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-left">
        {block.caption && (
          <caption className="mono pb-1 text-left text-ink-3">
            <Spans spans={block.caption} />
          </caption>
        )}
        {block.head && (
          <thead>
            <tr>
              {block.head.map((cell, i) => (
                <th key={i} scope="col" className="border-b border-line py-1 pr-4 font-semibold text-ink">
                  <Spans spans={cell} />
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} className="border-b border-line py-1 pr-4">
                  <Spans spans={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SKELETON_WIDTHS = ["w-[86%]", "w-[64%]", "w-[74%]"];

function Skeleton({ pulse }: { pulse: boolean }) {
  return (
    <div className="grid gap-2 pt-1" data-testid="draft-skeleton" role="status" aria-label="Writing the draft">
      {SKELETON_WIDTHS.map((width, i) => (
        <motion.span
          key={i}
          className={`block h-2 rounded-full bg-line ${width}`}
          initial={false}
          animate={pulse ? { opacity: [0.55, 1] } : { opacity: 1 }}
          transition={pulse ? { duration: 1.2, ease: "easeInOut", repeat: Infinity, repeatType: "mirror" } : { duration: 0 }}
        />
      ))}
    </div>
  );
}

function Outline({ markdown }: { markdown: string }) {
  const headings = draftHeadings(markdown);
  if (headings.length === 0) {
    // A draft without headings: its first line stands in for the outline.
    const first = markdown.split(/\r?\n/).find((line) => line.trim()) ?? "";
    return <p className="line-clamp-2 text-[13px] leading-[1.6] text-ink-2">{plain(first.trim())}</p>;
  }
  const top = Math.min(...headings.map((h) => h.level));
  return (
    <ol className="text-[13px] leading-[1.6] text-ink-2" data-testid="draft-outline">
      {headings.map((h, i) => (
        <li key={i} className={h.level > top ? "pl-4" : undefined}>
          {h.text}
        </li>
      ))}
    </ol>
  );
}

export type DraftCardProps = {
  /** The draft's title; shown as "<Title>.pdf". */
  title: string;
  /** The draft in markdown. Leave out while it is being written: the card shows skeleton lines. */
  markdown?: string;
  /** Start with the full text showing. Default false. */
  defaultExpanded?: boolean;
  /** She tapped "Hand in". */
  onHandIn: () => void;
  className?: string;
};

export function DraftCard({ title, markdown, defaultExpanded = false, onHandIn, className = "" }: DraftCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const previewId = useId();
  const mode = useMotionMode();

  const text = markdown?.trim() ?? "";
  const ready = text.length > 0;
  const open = ready && expanded;
  const pages = ready ? draftPages(text) : 0;
  const fade =
    mode === "instant"
      ? { duration: 0 }
      : { duration: mode === "calm" ? calmDuration : duration.base, ease: ease.out };

  return (
    <section
      className={`rounded-[20px] border border-line bg-surface p-4 shadow-[var(--shadow-card)] ${className}`}
      aria-label={`Draft: ${draftFileName(title)}`}
      data-testid="draft-card"
      data-state={!ready ? "skeleton" : open ? "expanded" : "outline"}
    >
      <div className="flex items-center gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-[14px] bg-butter text-ink">
          <StackIcon />
        </span>
        <div className="min-w-0">
          <p className="mono text-ink [overflow-wrap:anywhere]">{draftFileName(title)}</p>
          <p className="mt-0.5 text-[13px] text-ink-3">
            {ready ? `${pages} ${pages === 1 ? "page" : "pages"} · draft` : "draft"}
          </p>
        </div>
      </div>

      <div className="mt-4 min-h-10">
        {ready ? (
          <motion.div key="outline" initial={mode === "instant" ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={fade}>
            <Outline markdown={text} />
          </motion.div>
        ) : (
          <Skeleton pulse={mode === "full"} />
        )}
      </div>

      <div
        id={previewId}
        hidden={!open}
        data-testid="draft-preview"
        className="mt-3.5 space-y-2.5 border-l-2 border-line pl-3 text-[13px] leading-[1.6] text-ink-2"
      >
        {open && <Preview markdown={text} />}
      </div>

      <div className="mt-4 flex gap-2">
        <Button
          variant="secondary"
          className="flex-1 !px-3"
          disabled={!ready}
          aria-expanded={open}
          aria-controls={previewId}
          onClick={() => setExpanded((now) => !now)}
        >
          {open ? "Hide" : "Read it"}
        </Button>
        <Button variant="primary" className="flex-1 !px-3" disabled={!ready} onClick={onHandIn}>
          Hand in
        </Button>
      </div>
    </section>
  );
}

function Preview({ markdown }: { markdown: string }): ReactNode {
  return draftSections(markdown).map((section, i) => (
    <div key={i} className="space-y-1.5">
      {section.heading !== undefined && <p className="font-semibold text-ink">{section.heading}</p>}
      {section.blocks.map((block, j) => (
        <BlockView key={j} block={block} />
      ))}
    </div>
  ));
}

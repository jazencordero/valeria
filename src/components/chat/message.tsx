"use client";

/**
 * Chat messages. Source: prototype main-flow.html CSS 837-928 (.msg-a,
 * .msg-u, .ask-list, .mtable, .src-line, .typing, .caret), JS 4274-4313
 * (makeMsg) and 4475-4517 (her bubble, typing dots).
 *
 * - AssistantMessage: the small cap mark (thinking while waiting, talking
 *   while typing) and a body typed by the typewriter. Paragraphs are typed;
 *   list items, table rows and source lines fade in 110 ms apart.
 * - UserMessage: her bubble, rising 8 px from the composer.
 * - TypingDots: three dots, aria-label "Ready is writing".
 *
 * Markdown is limited to paragraphs, lists, tables, **bold** and `code`.
 * Everything is rendered as React text, never as HTML.
 */
import { motion } from "motion/react";
import { useMemo, type ReactNode } from "react";
import { Vitonen } from "@/components/vitonen";
import {
  Caret,
  capTimeline,
  planTimeline,
  useReveal,
  type TimelineStep,
} from "@/components/ui/typewriter";
import { durationMs, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

/* ---------- Markdown, the small part we support ---------- */

export type Inline = { text: string; bold?: boolean; code?: boolean };
export type Block =
  | { type: "p"; spans: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "table"; caption?: Inline[]; head?: Inline[][]; rows: Inline[][][] };

/**
 * **bold** and `code`. An unclosed marker runs to the end, so streamed text
 * shows in its final style while it types instead of flashing the markers.
 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let bold = false;
  let code = false;
  let buf = "";
  const push = () => {
    if (!buf) return;
    const span: Inline = { text: buf };
    if (bold) span.bold = true;
    if (code) span.code = true;
    out.push(span);
    buf = "";
  };
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "`") {
      push();
      code = !code;
    } else if (!code && src[i] === "*" && src[i + 1] === "*") {
      push();
      bold = !bold;
      i++;
    } else {
      buf += src[i];
    }
  }
  push();
  return out;
}

const OL = /^\s*\d+[.)]\s+(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const TABLE_LINE = /^\s*\|/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function cells(line: string): Inline[][] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => parseInline(c.trim()));
}

/**
 * Splits markdown into blocks. A single line directly above a table (no
 * blank line between) is the table's caption, like the prototype's "MAPE".
 */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  // A one-line paragraph that may turn out to be the caption of a table below it.
  let captionable: { block: number; line: number } | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const ordered = OL.test(line);
    if (ordered || UL.test(line)) {
      const re = ordered ? OL : UL;
      const items: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        const m = re.exec(lines[i]);
        if (m) items.push(m[1]);
        else if (/^\s+/.test(lines[i]) && items.length) items[items.length - 1] += " " + lines[i].trim();
        else break;
        i++;
      }
      blocks.push({ type: "list", ordered, items: items.map(parseInline) });
      continue;
    }
    if (TABLE_LINE.test(line)) {
      const tableLine = i;
      const run: string[] = [];
      while (i < lines.length && TABLE_LINE.test(lines[i])) run.push(lines[i++]);
      let head: Inline[][] | undefined;
      let body = run;
      if (run.length > 1 && TABLE_RULE.test(run[1])) {
        head = cells(run[0]);
        body = run.slice(2);
      } else if (run.length === 1) {
        // Streaming: the header has arrived, the rule not yet.
        head = cells(run[0]);
        body = [];
      }
      const rows = body.filter((r) => !TABLE_RULE.test(r)).map(cells);
      let caption: Inline[] | undefined;
      const prev = blocks[blocks.length - 1];
      if (
        prev?.type === "p" &&
        captionable?.block === blocks.length - 1 &&
        captionable.line === tableLine - 1
      ) {
        blocks.pop();
        caption = prev.spans;
      }
      blocks.push({ type: "table", caption, head, rows });
      continue;
    }
    // Paragraph: soft-wrapped lines up to a blank line or another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !OL.test(lines[i]) &&
      !UL.test(lines[i]) &&
      !TABLE_LINE.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    captionable = para.length === 1 ? { block: blocks.length, line: i - 1 } : null;
    blocks.push({ type: "p", spans: parseInline(para.join(" ")) });
  }
  return blocks;
}

const plain = (spans: readonly Inline[]) => spans.map((s) => s.text).join("");

/* ---------- Pieces ---------- */

function FileIcon() {
  return (
    <svg className="ic size-[14px]" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3.5h6.5L18 8v12.5H7z" />
      <path d="M13.5 3.5V8H18" />
    </svg>
  );
}

function Mark({ state }: { state: "idle" | "talking" | "thinking" }) {
  return (
    <span className="mt-[2px] block w-5 leading-[0]" aria-hidden="true">
      <Vitonen size={20} state={state} />
    </span>
  );
}

function Span({ span, children }: { span: Inline; children: ReactNode }) {
  if (span.code) return <code className="mono-in">{children}</code>;
  if (span.bold) return <strong className="font-semibold text-ink">{children}</strong>;
  return <>{children}</>;
}

/** Plain, fully shown inline text (lists and tables). */
function Text({ spans }: { spans: readonly Inline[] }) {
  return (
    <>
      {spans.map((s, i) => (
        <Span key={i} span={s}>
          {s.text}
        </Span>
      ))}
    </>
  );
}

/** Inline text with the first `shown` characters visible and the rest laid out but invisible. */
function TypedText({ spans, shown, caret }: { spans: readonly Inline[]; shown: number; caret: boolean }) {
  // Where each span starts in the paragraph's text.
  const starts = spans.map((_, i) => spans.slice(0, i).reduce((n, s) => n + s.text.length, 0));
  // The caret sits after the last typed character, in that character's span.
  const caretSpan = caret && shown > 0 ? spanIndexOf(spans, shown - 1) : -1;
  return (
    <>
      {spans.map((s, i) => {
        const k = Math.max(0, Math.min(s.text.length, shown - starts[i]));
        return (
          <Span key={i} span={s}>
            {s.text.slice(0, k)}
            {i === caretSpan && <Caret />}
            {k < s.text.length && <span className="invisible">{s.text.slice(k)}</span>}
          </Span>
        );
      })}
    </>
  );
}

function spanIndexOf(spans: readonly Inline[], charIndex: number): number {
  let offset = 0;
  for (let i = 0; i < spans.length; i++) {
    offset += spans[i].text.length;
    if (charIndex < offset) return i;
  }
  return spans.length - 1;
}

/* ---------- Assistant message ---------- */

export type AssistantMessageProps = {
  /** The reply in markdown: paragraphs, lists, tables, **bold**, `code`. */
  text: string;
  /** Source lines under the reply, for example "A3_brief.pdf, p. 2". */
  sources?: readonly string[];
  /** False while the reply is still streaming in. Default true. */
  complete?: boolean;
  /** False shows it at once, for messages from history. Default true. */
  animate?: boolean;
  onDone?: () => void;
};

type Planned = {
  blocks: Block[];
  /** First unit of each block. */
  starts: number[];
  sourcesStart: number;
  at: number[];
};

function plan(text: string, sources: readonly string[]): Planned {
  const blocks = parseMarkdown(text);
  const steps: TimelineStep[] = [];
  const starts: number[] = [];
  let units = 0;
  for (const b of blocks) {
    starts.push(units);
    if (b.type === "p") {
      const t = plain(b.spans);
      steps.push({ kind: "text", text: t });
      units += t.length;
    } else {
      const n =
        b.type === "list" ? b.items.length : (b.caption ? 1 : 0) + (b.head ? 1 : 0) + b.rows.length;
      steps.push({ kind: "reveal", count: n });
      units += n;
    }
  }
  steps.push({ kind: "reveal", count: sources.length });
  return { blocks, starts, sourcesStart: units, at: capTimeline(planTimeline(steps)) };
}

const NO_SOURCES: readonly string[] = [];

export function AssistantMessage({
  text,
  sources = NO_SOURCES,
  complete = true,
  animate = true,
  onDone,
}: AssistantMessageProps) {
  const mode = useMotionMode();
  const { blocks, starts, sourcesStart, at } = useMemo(() => plan(text, sources), [text, sources]);
  const { shown, finished, finish, immediate } = useReveal(at, {
    complete,
    instant: !animate,
    onDone,
  });

  const waiting = !complete && at.length === 0;
  if (waiting) return <TypingDots />;

  // Fades only when it is actually typing; otherwise things just appear.
  const fades = !immediate && mode === "full";
  const reveal = (unit: number) =>
    [
      unit < shown ? "opacity-100" : "pointer-events-none opacity-0",
      fades ? "transition-opacity duration-[160ms] ease-linear" : "",
    ].join(" ");

  // The caret stays in the last paragraph that has started typing.
  const caretBlock = finished
    ? -1
    : blocks.reduce((last, b, i) => (b.type === "p" && shown > starts[i] ? i : last), -1);

  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-[10px]" aria-busy={!finished}>
      <Mark state={finished ? "idle" : "talking"} />
      <div
        className="min-w-0 space-y-[10px] text-[15px] leading-[1.5] text-ink"
        onClick={finished ? undefined : finish}
      >
        {blocks.map((b, i) => {
          const s = starts[i];
          if (b.type === "p") {
            return (
              <p key={i}>
                <TypedText spans={b.spans} shown={shown - s} caret={i === caretBlock} />
              </p>
            );
          }
          if (b.type === "list") {
            const List = b.ordered ? "ol" : "ul";
            return (
              <List
                key={i}
                className={`grid gap-[6px] pl-5 marker:font-mono marker:text-[12px] marker:text-ink-3 ${
                  b.ordered ? "list-decimal" : "list-disc"
                }`}
              >
                {b.items.map((item, j) => (
                  <li key={j} className={reveal(s + j)}>
                    <Text spans={item} />
                  </li>
                ))}
              </List>
            );
          }
          let u = s;
          const captionUnit = b.caption ? u++ : -1;
          const headUnit = b.head ? u++ : -1;
          const rowStart = u;
          return (
            <div key={i}>
              {b.caption && (
                <p className={`mono text-ink-3 ${reveal(captionUnit)}`}>
                  <Text spans={b.caption} />
                </p>
              )}
              <div
                role="table"
                aria-label={b.caption ? plain(b.caption) : undefined}
                className="mt-[6px] border-t border-line"
              >
                {b.head && (
                  <div role="row" className={`${ROW} ${reveal(headUnit)}`}>
                    {b.head.map((c, k) => (
                      <span key={k} role="columnheader" className={headCellClass(k)}>
                        <Text spans={c} />
                      </span>
                    ))}
                  </div>
                )}
                {b.rows.map((row, j) => (
                  <div key={j} role="row" className={`${ROW} ${reveal(rowStart + j)}`}>
                    {row.map((c, k) => (
                      <span key={k} role={k === 0 ? "rowheader" : "cell"} className={cellClass(k)}>
                        <Text spans={c} />
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {sources.map((src, j) => (
          <p
            key={`src-${j}`}
            className={`flex items-center gap-[6px] font-mono text-[12px] tracking-[0.02em] text-ink-3 ${reveal(
              sourcesStart + j,
            )}`}
          >
            <FileIcon />
            <span>{src}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

const ROW = "flex items-baseline gap-2 border-b border-line py-2";
function headCellClass(k: number): string {
  return `${k === 0 ? "min-w-0 flex-1" : "w-[92px] flex-none text-right"} font-mono text-[12px] tracking-[0.02em] text-ink-3`;
}
function cellClass(k: number): string {
  return k === 0
    ? "min-w-0 flex-1 font-medium"
    : "w-[92px] flex-none text-right font-mono text-[13px] tracking-[0.02em] text-ink-2 [&_strong]:font-semibold [&_strong]:text-ink";
}

/* ---------- Typing dots ---------- */

/** While she waits: the cap thinking and three bouncing dots. */
export function TypingDots() {
  const mode = useMotionMode();
  const moving = mode === "full";
  return (
    <div
      role="status"
      aria-label="Ready is writing"
      className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-[10px]"
    >
      <Mark state="thinking" />
      <div className="inline-flex h-[22px] items-center gap-1" aria-hidden="true">
        {[0, 0.15, 0.3].map((delay) => (
          <motion.i
            key={delay}
            className="block size-[6px] rounded-full bg-ink-3"
            initial={{ opacity: moving ? 0.3 : 0.6, y: 0 }}
            animate={moving ? { opacity: [0.3, 1, 0.3, 0.3], y: [0, -3, 0, 0] } : { opacity: 0.6, y: 0 }}
            transition={
              moving
                ? { duration: 1, times: [0, 0.35, 0.7, 1], ease: ease.inout, repeat: Infinity, delay }
                : { duration: 0 }
            }
          />
        ))}
      </div>
    </div>
  );
}

/* ---------- Her bubble ---------- */

export type UserMessageProps = {
  text: string;
  /** How far below its place it starts, in px (the composer). 8 to 160, default 8. */
  rise?: number;
  /** False shows it in place, for messages from history. Default true. */
  animate?: boolean;
};

export function UserMessage({ text, rise = 8, animate = true }: UserMessageProps) {
  const mode = useMotionMode();
  const dy = Math.max(8, Math.min(160, rise));
  const full = mode === "full";
  return (
    <motion.div
      className="max-w-[82%] self-end rounded-[20px_20px_6px_20px] bg-accent-wash px-[14px] py-[10px] text-[15px] leading-[1.45] text-ink [overflow-wrap:anywhere]"
      initial={animate ? (full ? { opacity: 0, y: dy, scale: 0.96 } : { opacity: 0 }) : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={
        full
          ? { duration: durationMs.base / 1000, ease: ease.out }
          : { duration: mode === "instant" ? 0 : 0.15, ease: "linear" }
      }
    >
      {text}
    </motion.div>
  );
}

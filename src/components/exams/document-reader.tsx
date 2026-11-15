"use client";

/**
 * Document reader (M3-54): one exam document from her bundle, read in a
 * 680 px column like the lecture reader (M9-09): a back button to the exam
 * page, a mono kicker with the reading minutes, the title, then the text.
 *
 * Markdown goes through the chat's parser (`parseMarkdown` in
 * `components/chat/message.tsx`: paragraphs, lists, tables, **bold**, `code`).
 * It has no headings or fenced code, so this file only splits those lines out
 * first and hands every other run of lines to that parser. Everything is
 * rendered as React text, never as HTML. A first heading that repeats the
 * title is dropped (the importer takes the title from it).
 *
 * Three more things a hand-written document uses and the chat does not:
 * - A line of `---` (or `***`, `___`) is a rule between parts, not the text "---".
 * - `*word*` is emphasis. Underscores are left alone: formulas write `x_t`.
 * - Lines of one paragraph stay on their own lines (a mock exam lists its
 *   statements and its (a), (b), (c) parts one per line with no blank line
 *   between). The chat parser joins them with a space, so the break is carried
 *   through it as `LINE_BREAK` and drawn as a line break here.
 *
 * Tables sit in a box that scrolls sideways inside itself, so a wide mock-exam
 * table never widens the page at 390 px.
 *
 * Back goes to `/exams/<id>`: the exam page's tabs remember the tab she was
 * on (M3-47, sessionStorage), so she lands where she came from.
 *
 * Read only. Cut: notes, highlights, a mock-exam timer or marking.
 */
import { parseInline, parseMarkdown, type Block, type Inline } from "@/components/chat/message";
import { Button } from "@/components/ui/button";

export type DocumentReaderProps = {
  examId: string;
  title: string;
  /** The document's Markdown, as imported. */
  bodyMd: string;
  /** Reading minutes, at least 1. */
  minutes: number;
};

type Piece =
  | { type: "h"; level: 2 | 3 | 4; spans: Inline[] }
  | { type: "pre"; text: string }
  | { type: "hr" }
  | Block;

const HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;
const RULE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE_LINE = /^\s*\|/;

/** A kept line break inside a paragraph (a private-use character, so `trim()` leaves it). */
export const LINE_BREAK = "\uE000";

/** Headings and fenced code here; every other run of lines through `parseMarkdown`. */
export function documentPieces(src: string, title?: string): Piece[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Piece[] = [];
  let run: string[] = [];
  // Where the line before sits, as the chat parser will read it.
  let inList = false;
  let inParagraph = false;
  const flush = () => {
    if (run.length) out.push(...parseMarkdown(run.join("\n")));
    run = [];
    inList = false;
    inParagraph = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      out.push({ type: "pre", text: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      // The page title is the h1: the document's # and ## are both sections (h2).
      const level = Math.min(4, Math.max(2, h[1].length)) as 2 | 3 | 4;
      out.push({ type: "h", level, spans: parseInline(h[2]) });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push({ type: "hr" });
      continue;
    }
    if (!line.trim() || TABLE_LINE.test(line)) {
      inList = false;
      inParagraph = false;
    } else if (LIST_ITEM.test(line)) {
      inList = true;
      inParagraph = false;
    } else if (!(inList && /^\s/.test(line))) {
      // A paragraph line (not the indented rest of a list item): keep the break before it.
      if (inParagraph) run[run.length - 1] += LINE_BREAK;
      inList = false;
      inParagraph = true;
    }
    run.push(line);
  }
  flush();
  const first = out[0];
  if (title && first?.type === "h" && plain(first.spans).trim() === title.trim()) out.shift();
  return out;
}

const plain = (spans: readonly Inline[]) =>
  spans
    .map((s) => s.text)
    .join("")
    .replaceAll(LINE_BREAK, " ");

// `*word*`: the stars hug the words and do not touch a letter, digit or star outside ("2*3*4" stays).
const EMPHASIS = /(^|[^\w*])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?![\w*])/g;

/** Text with `*emphasis*` split out. */
export function emphasisParts(text: string): { text: string; em?: true }[] {
  const out: { text: string; em?: true }[] = [];
  let last = 0;
  for (const m of text.matchAll(EMPHASIS)) {
    const start = m.index + m[1].length;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: m[2], em: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Plain or bold text: emphasis in italics, kept line breaks as breaks. */
function Words({ text }: { text: string }) {
  return (
    <>
      {text.split(LINE_BREAK).map((line, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {emphasisParts(i > 0 ? line.replace(/^ /, "") : line).map((part, j) =>
            part.em ? <em key={j}>{part.text}</em> : <span key={j}>{part.text}</span>,
          )}
        </span>
      ))}
    </>
  );
}

function Text({ spans }: { spans: readonly Inline[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.code ? (
          <code key={i} className="rounded-[4px] bg-paper px-1 font-mono text-[0.88em]">
            {s.text.replaceAll(LINE_BREAK, " ")}
          </code>
        ) : s.bold ? (
          <strong key={i} className="font-semibold text-ink">
            <Words text={s.text} />
          </strong>
        ) : (
          <Words key={i} text={s.text} />
        ),
      )}
    </>
  );
}

const HEADING_CLASS: Record<2 | 3 | 4, string> = {
  2: "mt-10 text-[24px] leading-[1.2]",
  3: "mt-8 text-[19px] leading-[1.25] font-semibold",
  4: "mt-6 text-[17px] leading-[1.3] font-semibold",
};

function PieceView({ piece }: { piece: Piece }) {
  switch (piece.type) {
    case "h": {
      const H = `h${piece.level}` as const;
      return (
        <H className={HEADING_CLASS[piece.level]}>
          <Text spans={piece.spans} />
        </H>
      );
    }
    case "hr":
      return <hr className="mt-8 border-0 border-t border-solid border-line" />;
    case "pre":
      return (
        <pre className="mt-4 overflow-x-auto overscroll-x-contain rounded-xl border border-solid border-line bg-paper p-4 font-mono text-[13px] leading-[1.5]">
          <code>{piece.text}</code>
        </pre>
      );
    case "p":
      return (
        <p className="mt-3">
          <Text spans={piece.spans} />
        </p>
      );
    case "list": {
      const List = piece.ordered ? "ol" : "ul";
      return (
        <List
          className={`mt-3 grid gap-1.5 pl-[22px] marker:text-ink-3 ${piece.ordered ? "list-decimal marker:font-mono marker:text-[14px]" : "list-disc"}`}
        >
          {piece.items.map((item, j) => (
            <li key={j}>
              <Text spans={item} />
            </li>
          ))}
        </List>
      );
    }
    case "table":
      return (
        <figure className="mt-4">
          {piece.caption && (
            <figcaption className="mono mb-1.5 text-ink-3">
              <Text spans={piece.caption} />
            </figcaption>
          )}
          <div
            data-table-scroll=""
            tabIndex={0}
            role="region"
            aria-label={piece.caption ? plain(piece.caption) : "Table"}
            className="overflow-x-auto overscroll-x-contain rounded-xl border border-solid border-line focus-visible:outline-2 focus-visible:outline-ink"
          >
            <table className="min-w-full border-collapse text-left text-[15px] leading-[1.45]">
              {piece.head && (
                <thead>
                  <tr className="border-b border-solid border-line bg-paper">
                    {piece.head.map((c, k) => (
                      <th
                        key={k}
                        scope="col"
                        className="mono whitespace-nowrap px-3 py-2 align-bottom font-medium text-ink-2"
                      >
                        <Text spans={c} />
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {piece.rows.map((row, j) => (
                  <tr key={j} className="border-b border-solid border-line last:border-b-0">
                    {row.map((c, k) => (
                      <td key={k} className="min-w-[8.5rem] px-3 py-2 align-top">
                        <Text spans={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </figure>
      );
  }
}

const BackIcon = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="h-5 w-5 flex-none fill-none stroke-current"
    style={{ strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }}
  >
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </svg>
);

export function DocumentReader({ examId, title, bodyMd, minutes }: DocumentReaderProps) {
  const pieces = documentPieces(bodyMd, title);
  return (
    <div
      data-testid="document-reader"
      className="mx-auto max-w-[680px] min-w-0 px-[var(--pad)] pt-[max(20px,env(safe-area-inset-top,0px))] pb-16"
    >
      <Button variant="icon" href={`/exams/${encodeURIComponent(examId)}`} aria-label="Back to exam" className="-ml-3">
        <BackIcon />
      </Button>
      <p className="mono mt-3 text-ink-3">EXAM DOCUMENT · {minutes} MIN READ</p>
      <h1 tabIndex={-1} className="mt-2 text-[34px] leading-[1.1] outline-none [overflow-wrap:anywhere]">
        {title}
      </h1>
      <article aria-label={title} className="mt-6 min-w-0 text-[17px] [&>:first-child]:mt-0 leading-[1.6] text-ink [overflow-wrap:anywhere]">
        {pieces.map((p, i) => (
          <PieceView key={i} piece={p} />
        ))}
      </article>
    </div>
  );
}

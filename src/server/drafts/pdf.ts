/*
 * M2-20: the draft as a PDF she can hand in.
 *
 *   const { bytes, pages, fileName } = await draftToPdf(draft, {
 *     studentName: "Valeria", courseName: "Microeconomics", model: "openai/gpt-oss-120b",
 *   });
 *
 * Renders the draft's markdown (headings, paragraphs, bullet and numbered lists, simple pipe
 * tables, **bold**, *italic* and `code`) onto A4 pages with @react-pdf/renderer, in one plain
 * template: course, title and her name on top, page numbers at the foot.
 *
 * The last section is always "Use of AI". Aalto's rules say AI use must be disclosed (the model
 * and the date) and AI text may not be handed in as her own (context/decisions.md). So:
 * - No such section in the draft: one is added with the model, the date and
 *   "Drafted with Ready, an AI study tool, and edited by me."
 * - She wrote or edited her own "Use of AI" section (a heading of any level with that text):
 *   her wording is kept and moved to the end. If her text leaves out the model or the date, the
 *   missing line is put back above her words. An empty section gets the default sentence.
 * She can change the words; she cannot make the section go away.
 *
 * Only the built-in PDF fonts are used (no font files ship with the app), so text is limited to
 * what they can draw (Latin letters incl. ä, ö, å, é). Other characters, such as emoji or
 * non-Latin scripts, are replaced with "?" rather than drawn as garbage.
 *
 * Cut (ticket): no charts or images, one template.
 *
 * @react-pdf/renderer is in Next's built-in `serverExternalPackages` list, so it is loaded with
 * Node's own require on the server and needs no entry in next.config.ts. Server only.
 */
import { createElement as h, type ReactElement, type ReactNode } from "react";
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";

export const USE_OF_AI_HEADING = "Use of AI";
export const USE_OF_AI_SENTENCE = "Drafted with Ready, an AI study tool, and edited by me.";

export type DraftForPdf = { title: string | null; contentMd: string };

export type PdfOptions = {
  studentName: string;
  courseName: string;
  /** The model that wrote the draft, as recorded (e.g. "openai/gpt-oss-120b"). */
  model: string;
  /** The date the AI was used. Defaults to now. */
  date?: Date;
};

export type DraftPdf = { bytes: Uint8Array; pages: number; fileName: string };

// Words are never split with a hyphen: a hyphen in the middle of her words reads like a typo
// on a hand-in, and it keeps the text layer searchable.
Font.registerHyphenationCallback((word) => [word]);

/* ------------------------------------------------------------------------- */
/* Markdown, the small part of it a draft uses.                              */
/* ------------------------------------------------------------------------- */

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] };

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

function isTableRow(line: string): boolean {
  return line.includes("|");
}

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

/** Splits markdown into blocks. Anything it does not know is a paragraph of plain text. */
export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || RULE.test(line)) {
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() !== "" && isTableRow(lines[i])) {
        const row = cells(lines[i]);
        // Every row gets as many cells as the header: extra ones are dropped, missing ones empty.
        rows.push(header.map((_, c) => row[c] ?? ""));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const start = numbered ? Number(numbered[1]) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const b = BULLET.exec(l);
        const n = NUMBERED.exec(l);
        const item = ordered ? n?.[2] : b?.[1];
        if (item !== undefined) {
          items.push(item);
          i++;
        } else if (l.trim() !== "" && /^\s{2,}\S/.test(l) && items.length > 0 && !HEADING.test(l)) {
          // An indented line carries on the item above it (nested lists are flattened into it).
          items[items.length - 1] += " " + l.trim().replace(/^([-*+]|\d{1,9}[.)])\s+/, "");
          i++;
        } else {
          break;
        }
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }

    // A paragraph: lines up to a blank line or the start of another block.
    const text: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "" || HEADING.test(l) || BULLET.test(l) || NUMBERED.test(l) || RULE.test(l)) break;
      if (text.length > 0 && isTableRow(l) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) break;
      text.push(l.trim());
      i++;
    }
    blocks.push({ kind: "paragraph", text: text.join(" ") });
  }
  return blocks;
}

/* ------------------------------------------------------------------------- */
/* The "Use of AI" section.                                                  */
/* ------------------------------------------------------------------------- */

/** Her date line, written the same way every time: "15 November 2026" (Helsinki time). */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Helsinki",
  }).format(date);
}

function plain(text: string): string {
  return inlineRuns(text)
    .map((r) => r.text)
    .join("")
    .trim();
}

function isUseOfAi(block: Block): boolean {
  return block.kind === "heading" && plain(block.text).replace(/[:.\s]+$/, "").toLowerCase() === "use of ai";
}

/**
 * The draft's blocks with the "Use of AI" section moved to the end and filled in where she left
 * out the model or the date. Exported for tests.
 */
export function withUseOfAi(blocks: Block[], model: string, date: Date): Block[] {
  const dateText = formatDate(date);
  const at = blocks.findIndex(isUseOfAi);
  const modelLine: Block = { kind: "paragraph", text: `Model: ${model}` };
  const dateLine: Block = { kind: "paragraph", text: `Date: ${dateText}` };
  const heading: Block = { kind: "heading", level: 2, text: USE_OF_AI_HEADING };

  if (at === -1) {
    return [...blocks, heading, modelLine, dateLine, { kind: "paragraph", text: USE_OF_AI_SENTENCE }];
  }

  // Her section runs until the next heading of the same or a higher level.
  const level = (blocks[at] as { level: number }).level;
  let end = at + 1;
  while (end < blocks.length) {
    const b = blocks[end];
    if (b.kind === "heading" && b.level <= level) break;
    end++;
  }
  // Any further "Use of AI" headings later on are folded into the one section.
  const rest = [...blocks.slice(0, at), ...blocks.slice(end)];
  const extra = rest.findIndex(isUseOfAi);
  const before = extra === -1 ? rest : withoutSection(rest, extra);
  const body = blocks.slice(at + 1, end).filter((b) => !(b.kind === "heading" && isUseOfAi(b)));

  const said = body.map(blockText).join("\n").toLowerCase();
  const added: Block[] = [];
  if (!said.includes(model.toLowerCase())) added.push(modelLine);
  if (!said.includes(dateText.toLowerCase()) && !/\bdate\b/.test(said)) added.push(dateLine);
  const words = body.length > 0 ? body : [{ kind: "paragraph", text: USE_OF_AI_SENTENCE } as Block];
  return [...before, heading, ...added, ...words];
}

function withoutSection(blocks: Block[], at: number): Block[] {
  const level = (blocks[at] as { level: number }).level;
  let end = at + 1;
  while (end < blocks.length) {
    const b = blocks[end];
    if (b.kind === "heading" && b.level <= level) break;
    end++;
  }
  // Keep what she wrote there; only the duplicate heading goes.
  return [...blocks.slice(0, at), ...blocks.slice(at + 1, end), ...blocks.slice(end)];
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "heading":
    case "paragraph":
      return plain(block.text);
    case "list":
      return block.items.map(plain).join("\n");
    case "table":
      return [block.header, ...block.rows].map((r) => r.map(plain).join(" ")).join("\n");
  }
}

/* ------------------------------------------------------------------------- */
/* Inline text.                                                              */
/* ------------------------------------------------------------------------- */

type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

const INLINE = /(\*\*|__)(.+?)\1|(\*|_)(?=\S)(.+?)(?<=\S)\3(?![\w*])|`([^`]+)`|!?\[([^\]]*)\]\([^)]*\)/g;

/**
 * Only characters the built-in Helvetica (WinAnsi) can draw; others become "?". Typographic
 * quotes and dashes are inside WinAnsi, so they stay.
 */
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
export function drawable(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const code = ch.codePointAt(0)!;
    if (ch === "\t") out += " ";
    else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue;
    else if (code <= 0xff || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (code === 0x2212) out += "-";
    else if (code === 0x00a0 || code === 0x202f || code === 0x2009) out += " ";
    else out += "?";
  }
  return out;
}

function inlineRuns(text: string): Run[] {
  const runs: Run[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[2] !== undefined) runs.push({ text: m[2], bold: true });
    else if (m[4] !== undefined) runs.push({ text: m[4], italic: true });
    else if (m[5] !== undefined) runs.push({ text: m[5], code: true });
    else runs.push({ text: m[6] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.map((r) => ({ ...r, text: r.text.replace(/\\([\\`*_[\]()#+\-.!|])/g, "$1") }));
}

function inline(text: string): ReactNode[] {
  return inlineRuns(text).map((r, i) =>
    r.bold || r.italic || r.code
      ? h(Text, { key: i, style: r.code ? styles.code : r.bold ? styles.bold : styles.italic }, drawable(r.text))
      : drawable(r.text),
  );
}

/* ------------------------------------------------------------------------- */
/* The template.                                                             */
/* ------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  page: {
    paddingTop: 56,
    paddingBottom: 64,
    paddingHorizontal: 64,
    fontFamily: "Helvetica",
    fontSize: 11,
    lineHeight: 1.45,
    color: "#1a1a1a",
  },
  header: { marginBottom: 20 },
  course: { fontSize: 10, color: "#555555" },
  title: { fontFamily: "Helvetica-Bold", fontSize: 18, lineHeight: 1.25, marginTop: 4 },
  student: { fontSize: 10, color: "#555555", marginTop: 4 },
  h1: { fontFamily: "Helvetica-Bold", fontSize: 16, lineHeight: 1.25, marginTop: 14, marginBottom: 6 },
  h2: { fontFamily: "Helvetica-Bold", fontSize: 14, lineHeight: 1.25, marginTop: 12, marginBottom: 5 },
  h3: { fontFamily: "Helvetica-Bold", fontSize: 12, lineHeight: 1.3, marginTop: 10, marginBottom: 4 },
  paragraph: { marginBottom: 8 },
  bold: { fontFamily: "Helvetica-Bold" },
  italic: { fontFamily: "Helvetica-Oblique" },
  code: { fontFamily: "Courier", fontSize: 10 },
  list: { marginBottom: 8 },
  item: { flexDirection: "row", marginBottom: 2 },
  marker: { width: 18 },
  itemText: { flex: 1 },
  table: { marginBottom: 10, borderTopWidth: 0.75, borderLeftWidth: 0.75, borderColor: "#999999" },
  row: { flexDirection: "row" },
  cell: { flex: 1, padding: 4, borderRightWidth: 0.75, borderBottomWidth: 0.75, borderColor: "#999999", fontSize: 10 },
  headCell: { fontFamily: "Helvetica-Bold", backgroundColor: "#f0f0f0" },
  footer: { position: "absolute", bottom: 32, left: 64, right: 64, fontSize: 9, color: "#777777", textAlign: "right" },
});

function renderBlock(block: Block, key: number): ReactElement {
  switch (block.kind) {
    case "heading": {
      const style = block.level <= 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3;
      // A heading stays on the page of the text that follows it.
      return h(Text, { key, style, minPresenceAhead: 40 }, ...inline(block.text));
    }
    case "paragraph":
      return h(Text, { key, style: styles.paragraph }, ...inline(block.text));
    case "list":
      return h(
        View,
        { key, style: styles.list },
        ...block.items.map((item, i) =>
          h(
            View,
            { key: i, style: styles.item, wrap: false },
            h(Text, { style: styles.marker }, block.ordered ? `${block.start + i}.` : "•"),
            h(Text, { style: styles.itemText }, ...inline(item)),
          ),
        ),
      );
    case "table":
      return h(
        View,
        { key, style: styles.table },
        h(
          View,
          { style: styles.row, wrap: false, fixed: false },
          ...block.header.map((c, i) => h(Text, { key: i, style: [styles.cell, styles.headCell] }, ...inline(c))),
        ),
        ...block.rows.map((row, r) =>
          h(
            View,
            { key: r, style: styles.row, wrap: false },
            ...row.map((c, i) => h(Text, { key: i, style: styles.cell }, ...inline(c))),
          ),
        ),
      );
  }
}

/** `<course>-<title>.pdf`, ASCII letters, digits and dashes only, at most 100 characters before `.pdf`. */
export function pdfFileName(courseName: string, title: string | null): string {
  const slug = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const base = [slug(courseName), slug(title ?? "")].filter(Boolean).join("-").slice(0, 100).replace(/-+$/, "");
  return `${base || "draft"}.pdf`;
}

/** Counts the page objects in a PDF (`/Type /Page`, not `/Pages`). */
export function countPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  return text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
}

export async function draftToPdf(draft: DraftForPdf, options: PdfOptions): Promise<DraftPdf> {
  const date = options.date ?? new Date();
  const model = options.model.trim() || "not recorded";
  const title = (draft.title ?? "").trim() || "Draft";
  const blocks = withUseOfAi(parseMarkdown(draft.contentMd), model, date);
  const studentName = options.studentName.trim();

  const doc = h(
    Document,
    {
      title: drawable(title),
      author: studentName ? drawable(studentName) : undefined,
      subject: drawable(options.courseName),
      creator: "Ready",
      producer: "Ready",
      language: "en",
      creationDate: date,
    },
    h(
      Page,
      { size: "A4", style: styles.page, wrap: true },
      h(
        View,
        { style: styles.header },
        options.courseName.trim() ? h(Text, { style: styles.course }, drawable(options.courseName.trim())) : null,
        h(Text, { style: styles.title }, drawable(title)),
        studentName ? h(Text, { style: styles.student }, drawable(studentName)) : null,
      ),
      ...blocks.map(renderBlock),
      h(Text, {
        style: styles.footer,
        fixed: true,
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
          `${pageNumber} / ${totalPages}`,
      }),
    ),
  );

  const buffer = await renderToBuffer(doc);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return { bytes, pages: countPages(bytes), fileName: pdfFileName(options.courseName, draft.title) };
}

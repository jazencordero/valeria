"use client";

/**
 * Select text in a lecture to start a note (M9-16).
 * Source: prototype merged.html JS 5536-5592 (applyHighlights, wrapRange,
 * onSelection, noteFromSelection) and CSS 1076, 1088 (mark.hl, .sel-note).
 *
 * - Only while `active` (the reader's Read view): selecting more than two
 *   characters inside the lecture text shows a small "Add note" button above
 *   the selection; below it on touch screens, or when the selection is near
 *   the top (of the page or of the screen, under the sticky header).
 * - Pressing it keeps the selection (the press does not take it away), marks
 *   the text with a butter highlight that wipes in from the left (300 ms;
 *   calm mode a 150 ms fade, instant mode none) and hands the text to
 *   `onAdd`, which stores it and opens the notepad with it as the quote. The
 *   quote is the selected text with its whitespace collapsed.
 * - `highlights` (the stored ones) are re-applied whenever the Read view is
 *   showing, by matching the text against the lecture's text, across
 *   paragraphs too. Applying twice changes nothing.
 *
 * The highlighted text is wrapped in `<mark class="hl">` inside the reader's
 * own DOM, as the prototype does. React leaves those text nodes alone (the
 * lecture text does not change while the page is open), and switching views
 * remounts the article, after which the highlights are applied again.
 *
 * Plain props, no fetching. `containerRef` is the positioned element the
 * button is placed in; it holds the reader.
 *
 * Cut: first match only when the same text appears twice; no removing a
 * highlight; the notepad button is not hidden on phones while "Add note"
 * shows (the notepad exposes no way to hide it). Not verified: selecting by
 * touch on a real phone.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { ease } from "@/lib/motion/tokens";
import { fade } from "@/lib/motion/transitions";
import { useMotionMode, type MotionMode } from "@/lib/motion/use-calm";

export const ADD_NOTE = "Add note";
/** The notepad's quote limit (src/app/(app)/notes/actions.ts). */
export const QUOTE_MAX = 4_000;
/** The lecture text the selection must sit in. */
const ARTICLE = "article.lec-body";
const MARK_CLASS = "hl rounded-[3px] bg-butter text-inherit box-decoration-clone";
const WIPE_MS = 300;
const BUTTON_W = 120;
const BUTTON_H = 56;

/** The selected text as a quote: whitespace collapsed, trimmed, capped. */
export function quoteOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, QUOTE_MAX);
}

/** More than two characters: enough to note. */
export function canNote(text: string): boolean {
  return quoteOf(text).length > 2;
}

export type Rect = { top: number; bottom: number; left: number; width: number };

/** Where the button goes, in the container's coordinates. */
export function placeButton(sel: Rect, box: Rect, coarse: boolean): { left: number; top: number; below: boolean } {
  const below = coarse || sel.top - box.top < 80 || sel.top < 120;
  const left = Math.max(0, Math.min(box.width - BUTTON_W, sel.left + sel.width / 2 - box.left - BUTTON_W / 2));
  const top = below ? sel.bottom - box.top + 10 : sel.top - box.top - BUTTON_H;
  return { left, top, below };
}

function play(mark: HTMLElement, mode: MotionMode) {
  if (mode === "instant" || typeof mark.animate !== "function") return;
  if (mode === "calm") {
    mark.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "linear" });
    return;
  }
  mark.animate([{ clipPath: "inset(0px 100% 0px 0px)" }, { clipPath: "inset(0px 0% 0px 0px)" }], {
    duration: WIPE_MS,
    easing: `cubic-bezier(${ease.out.join(",")})`,
  });
}

/** Wraps the text of `range` in butter marks tagged with `quote`; returns the marks. */
export function wrapRange(range: Range, quote: string, mode: MotionMode): HTMLElement[] {
  const common = range.commonAncestorContainer;
  const root = common.nodeType === Node.TEXT_NODE ? common.parentNode : common;
  if (!root) return [];
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: [Text, number, number][] = [];
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (!range.intersectsNode(node)) continue;
    if (node.parentElement?.closest("mark.hl")) continue;
    const s = node === range.startContainer ? range.startOffset : 0;
    const e = node === range.endContainer ? range.endOffset : node.length;
    if (e > s && node.data.slice(s, e).trim()) parts.push([node, s, e]);
  }
  return parts.map(([node, s, e]) => {
    const mid = s > 0 ? node.splitText(s) : node;
    if (e - s < mid.length) mid.splitText(e - s);
    const mark = doc.createElement("mark");
    mark.className = MARK_CLASS;
    mark.dataset.quote = quote;
    mid.parentNode?.insertBefore(mark, mid);
    mark.appendChild(mid);
    play(mark, mode);
    return mark;
  });
}

/** The text under `root` with whitespace collapsed, and where each character came from. */
function textIndex(root: HTMLElement): { flat: string; at: [Text, number][] } {
  const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let flat = "";
  const at: [Text, number][] = [];
  let space = true;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let i = 0; i < node.data.length; i++) {
      const ch = node.data[i];
      if (/\s/.test(ch)) {
        if (space) continue;
        flat += " ";
        space = true;
      } else {
        flat += ch;
        space = false;
      }
      at.push([node, i]);
    }
  }
  return { flat, at };
}

function hasMark(root: HTMLElement, quote: string): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>("mark.hl")).some((m) => m.dataset.quote === quote);
}

/** Marks each stored text where it first appears under `root`. Returns how many it marked now. */
export function applyHighlights(root: HTMLElement, texts: readonly string[]): number {
  let n = 0;
  for (const raw of texts) {
    const quote = quoteOf(raw);
    if (!canNote(quote) || hasMark(root, quote)) continue;
    const { flat, at } = textIndex(root);
    const i = flat.indexOf(quote);
    if (i < 0) continue;
    const [startNode, startOffset] = at[i];
    const [endNode, endOffset] = at[i + quote.length - 1];
    const range = (root.ownerDocument ?? document).createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset + 1);
    if (wrapRange(range, quote, "instant").length) n++;
  }
  return n;
}

export type SelectNoteProps = {
  /** The positioned element that holds the reader; the button is placed in it. */
  containerRef: RefObject<HTMLElement | null>;
  /** The reader is in Read view. */
  active: boolean;
  /** Stored highlights for this lecture. */
  highlights: readonly string[];
  /** She pressed "Add note": store the highlight and open the notepad with `quote`. */
  onAdd: (quote: string) => void;
};

export function SelectNote({ containerRef, active, highlights, onAdd }: SelectNoteProps) {
  const mode = useMotionMode();
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const range = useRef<Range | null>(null);
  // Pressing the button must not let the selection change hide it first.
  const hold = useRef(false);

  const article = useCallback(
    () => containerRef.current?.querySelector<HTMLElement>(ARTICLE) ?? null,
    [containerRef],
  );

  // Stored highlights, whenever the Read view is showing.
  useEffect(() => {
    if (!active) return;
    const art = article();
    if (art) applyHighlights(art, highlights);
  }, [active, highlights, article]);

  useEffect(() => {
    if (!active) return;
    const onSelection = () => {
      const box = containerRef.current;
      const art = article();
      const sel = document.getSelection();
      const ok =
        !!box &&
        !!art &&
        !!sel &&
        sel.rangeCount > 0 &&
        !sel.isCollapsed &&
        canNote(sel.toString()) &&
        art.contains(sel.anchorNode) &&
        art.contains(sel.focusNode);
      if (!ok || !box || !sel) {
        if (hold.current) return;
        range.current = null;
        setPos(null);
        return;
      }
      const rg = sel.getRangeAt(0);
      range.current = rg.cloneRange();
      const r = typeof rg.getBoundingClientRect === "function" ? rg.getBoundingClientRect() : null;
      const b = box.getBoundingClientRect();
      const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
      const p = r ? placeButton(r, b, coarse) : { left: 0, top: 0 };
      setPos({ left: p.left, top: p.top });
    };
    document.addEventListener("selectionchange", onSelection);
    return () => {
      document.removeEventListener("selectionchange", onSelection);
      // Leaving Read view drops the button.
      range.current = null;
      setPos(null);
    };
  }, [active, article, containerRef]);

  const add = () => {
    hold.current = false;
    const rg = range.current;
    range.current = null;
    setPos(null);
    if (!rg) return;
    const quote = quoteOf(rg.toString());
    if (!canNote(quote)) return;
    wrapRange(rg, quote, mode);
    document.getSelection()?.removeAllRanges();
    onAdd(quote);
  };

  if (!active || !pos) return null;
  const anim =
    mode === "full"
      ? {
          initial: { opacity: 0, y: 4, scale: 0.96 },
          animate: { opacity: 1, y: 0, scale: 1 },
          transition: { duration: 0.16, ease: ease.out },
        }
      : { initial: fade(mode).initial, animate: fade(mode).animate, transition: fade(mode).transition };

  return (
    <Button
      {...anim}
      variant="primary"
      size="sm"
      // The button sets `relative`; this one sits over the text.
      className="absolute! z-[7]"
      style={{ left: pos.left, top: pos.top }}
      data-testid="sel-note"
      onPointerDown={(e) => {
        e.preventDefault();
        hold.current = true;
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={add}
    >
      {ADD_NOTE}
    </Button>
  );
}

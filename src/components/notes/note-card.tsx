"use client";

/**
 * Note card on the Notes tab (ticket M9-14).
 * Source: prototype merged.html JS 5684-5695 (noteCardEl) and CSS 1097-1104
 * (.ncard, .ncard-t, .ncard-b, .ncard-f, .att, .ncard-d).
 *
 * The title (or "Untitled"; the butter marker behind it when highlighted),
 * the body clamped to three lines with the quote first in quotation marks,
 * then the attachment pill and the date. Tapping the card opens it (`onOpen`).
 * The small menu top right holds Delete, which asks once: the first press
 * turns it into "Yes, delete it", the second deletes.
 *
 * Plain data in, no fetching: the grid passes what to do on open and delete.
 */
import { motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

export type NoteCardData = {
  id: string;
  title: string | null;
  body: string;
  quote: string | null;
  highlighted: boolean;
  /** The attachment pill: "General", the course, "Lecture 5 · ...". */
  attachLabel: string;
  /** "THU 12 NOV", or "TODAY". */
  date: string;
};

export type NoteCardProps = {
  note: NoteCardData;
  onOpen: (note: NoteCardData) => void;
  /** Resolves when the delete has been answered; the grid hides the card. */
  onDelete: (note: NoteCardData) => Promise<void> | void;
  /** Spring in from 92%: the note was just created. */
  pop?: boolean;
};

/** Body as the card shows it: the quote first, in quotation marks. */
export function cardText(note: Pick<NoteCardData, "quote" | "body">): string {
  const quote = note.quote?.trim();
  return (quote ? `“${quote}”\n` : "") + note.body;
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="6" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="18" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

export function NoteCard({ note, onOpen, onDelete, pop = false }: NoteCardProps) {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuId = useId();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const itemRef = useRef<HTMLButtonElement | null>(null);

  const closeMenu = (focusToggle: boolean) => {
    setMenu(false);
    setConfirm(false);
    if (focusToggle) toggleRef.current?.focus({ preventScroll: true });
  };

  // Outside press closes the menu.
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) {
        setMenu(false);
        setConfirm(false);
      }
    };
    document.addEventListener("pointerdown", down);
    itemRef.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("pointerdown", down);
  }, [menu]);

  const del = async () => {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    try {
      await onDelete(note);
    } finally {
      setBusy(false);
      setMenu(false);
      setConfirm(false);
    }
  };

  const title = note.title?.trim() ? note.title : "Untitled";

  return (
    <motion.div
      initial={pop ? { opacity: 0, scale: 0.92 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", bounce: 0.3, duration: 0.35 }}
      data-note={note.id}
      className={
        "relative mb-3.5 break-inside-avoid rounded-[18px] border border-line bg-surface text-ink " +
        "shadow-[var(--shadow-card)] transition-[border-color] duration-quick ease-out [@media(hover:hover)]:hover:border-ink-3"
      }
    >
      <button
        type="button"
        onClick={() => onOpen(note)}
        className="block w-full cursor-pointer rounded-[18px] border-0 bg-transparent p-4 pr-11 text-left text-ink"
      >
        <span
          className={
            "inline font-display text-[17px] leading-[1.3] font-semibold [font-variation-settings:'SOFT'_100] " +
            (note.highlighted ? "rounded-[4px] bg-butter [box-decoration-break:clone] [-webkit-box-decoration-break:clone]" : "")
          }
        >
          {title}
        </span>
        {cardText(note).trim() ? (
          <span className="mt-2 line-clamp-3 text-[14px] whitespace-pre-line text-ink-2">{cardText(note)}</span>
        ) : null}
        <span className="mt-3 flex items-center justify-between gap-2">
          <span className="mono min-w-0 truncate rounded-full bg-paper px-2 py-0.5 text-[11px] text-ink-2">
            {note.attachLabel}
          </span>
          <span className="mono flex-none text-[11px] text-ink-3">{note.date}</span>
        </span>
      </button>

      <div
        ref={boxRef}
        className="absolute top-2 right-2"
        onKeyDown={(e) => {
          if (e.key === "Escape" && menu) {
            e.preventDefault();
            e.stopPropagation();
            closeMenu(true);
          }
        }}
      >
        <button
          ref={toggleRef}
          type="button"
          aria-label={`More for ${title}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-controls={menu ? menuId : undefined}
          onClick={() => (menu ? closeMenu(false) : setMenu(true))}
          className="grid h-9 w-9 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-ink-3 hover:bg-paper hover:text-ink"
        >
          <DotsIcon />
        </button>
        {menu ? (
          <div
            id={menuId}
            role="menu"
            aria-label="Note"
            className="absolute top-10 right-0 z-10 min-w-[160px] rounded-[14px] border border-line bg-surface p-1 shadow-[var(--shadow-lift)]"
          >
            <button
              ref={itemRef}
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={del}
              className={
                "block w-full cursor-pointer rounded-[10px] border-0 bg-transparent px-3 py-2.5 text-left text-[14px] " +
                "hover:bg-paper disabled:opacity-50 " +
                (confirm ? "font-medium text-due" : "text-ink")
              }
            >
              {confirm ? "Yes, delete it" : "Delete"}
            </button>
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}

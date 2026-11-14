"use client";

/**
 * M3-39: "Fix this card". A "⋯" button for the card head with two choices:
 *
 *   <CardMenu cardId={card.id} onDrop={(id, kind) => {
 *     dropFromSession(id);                // the session removes the card
 *     showDropToast(DROP_TOAST_TEXT);     // "Gone. Thanks, that makes the deck better."
 *   }} />
 *
 * - "This card is wrong" flags it (`flagged`): gone from this session and
 *   every future one.
 * - "Skip this card for now" suspends it (`suspended`).
 *
 * Both call `dropCard` (src/app/(app)/study/card-actions.ts). Only when it
 * answers ok does the menu call `onDrop(cardId, kind)`; the card then leaves
 * the screen, and this menu with it, so the confirming toast belongs to the
 * caller (the session frame's own toast has only its miss and climb texts;
 * the app toast sits under the frame). `DROP_TOAST_TEXT` is the sentence.
 * A failure keeps the card and shows one plain line under the button.
 * A second tap while the first is on its way does nothing.
 *
 * Keyboard (WAI-ARIA menu button): Enter, Space or ArrowDown opens on the
 * first item, ArrowUp on the last; ArrowUp/ArrowDown move (wrapping), Home
 * and End jump; Escape closes and puts focus back on the button (without
 * reaching the session's own Escape); Tab or a tap outside closes.
 *
 * Cut: no editing of card text, no reason picker.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { dropCard, type DropKind, type DropResult } from "@/app/(app)/study/card-actions";

export const DROP_TOAST_TEXT = "Gone. Thanks, that makes the deck better.";
export const DROP_ERROR_TEXT = "That did not work. The card is still here; try again.";

export const MENU_ITEMS: readonly { kind: DropKind; label: string }[] = [
  { kind: "flagged", label: "This card is wrong" },
  { kind: "suspended", label: "Skip this card for now" },
];

export type CardMenuProps = {
  cardId: string;
  /** Called once the card is flagged or suspended; drop it and show the toast. */
  onDrop: (cardId: string, kind: DropKind) => void;
  /** The Server Action; injectable for tests and previews. */
  action?: (cardId: string, kind: DropKind) => Promise<DropResult>;
  className?: string;
};

const DotsIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 fill-current">
    <circle cx="5.5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="18.5" cy="12" r="1.6" />
  </svg>
);

export function CardMenu({ cardId, onDrop, action = dropCard, className }: CardMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusOnOpen = useRef<"first" | "last">("first");
  const menuId = useId();
  const buttonId = useId();

  // Move focus into the menu when it opens.
  useEffect(() => {
    if (!open) return;
    const items = itemRefs.current;
    (focusOnOpen.current === "last" ? items[items.length - 1] : items[0])?.focus();
  }, [open]);

  // A tap outside closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function openMenu(at: "first" | "last") {
    focusOnOpen.current = at;
    setFailed(false);
    setOpen(true);
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  function onButtonKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      if (open) close(true);
      else openMenu("first");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openMenu("last");
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (i: number) => items[(i + items.length) % items.length]?.focus();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focus(at + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focus(at < 0 ? items.length - 1 : at - 1);
        break;
      case "Home":
        e.preventDefault();
        focus(0);
        break;
      case "End":
        e.preventDefault();
        focus(items.length - 1);
        break;
      case "Escape":
        // Keep it from the session frame, which opens its stop confirm on Escape.
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  }

  async function choose(kind: DropKind) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    let result: DropResult | null = null;
    try {
      result = await action(cardId, kind);
    } catch {
      result = null;
    }
    inFlight.current = false;
    setBusy(false);
    if (result?.ok) {
      setOpen(false);
      onDrop(cardId, kind);
    } else {
      close(true);
      setFailed(true);
    }
  }

  return (
    <div ref={rootRef} className={"relative inline-flex flex-col items-end " + (className ?? "")}>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        aria-label="Card options"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu("first"))}
        onKeyDown={onButtonKey}
        className="inline-flex size-9 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-[var(--color-accent-wash)] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
      >
        <DotsIcon />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-labelledby={buttonId}
          aria-busy={busy || undefined}
          onKeyDown={onMenuKey}
          className="absolute top-full right-0 z-[5] mt-1 flex min-w-[220px] flex-col rounded-2xl border border-solid border-line bg-surface p-1.5 shadow-[var(--shadow-card)]"
        >
          {MENU_ITEMS.map((item, i) => (
            <button
              key={item.kind}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-disabled={busy || undefined}
              onClick={() => void choose(item.kind)}
              className="rounded-xl px-3 py-2.5 text-left text-[15px] text-ink hover:bg-[var(--color-accent-wash)] focus-visible:bg-[var(--color-accent-wash)] focus-visible:outline-none aria-disabled:opacity-60"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {failed && (
        <p role="alert" className="mt-1 max-w-[260px] text-right text-[13px] text-ink-2">
          {DROP_ERROR_TEXT}
        </p>
      )}
    </div>
  );
}

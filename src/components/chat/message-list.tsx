"use client";

/**
 * The scrolling chat. Source: prototype main-flow.html JS 4343-4349
 * (pinChat), 2048-2054 (the scroll listener) and 4446-4451 (scrollChat).
 *
 * role="log". It stays pinned to the bottom while messages arrive and type,
 * unless she has scrolled more than 40 px up; coming back near the bottom
 * pins it again. scrollToEnd() (when she sends) pins it on purpose.
 *
 *   const list = useRef<MessageListHandle>(null);
 *   <MessageList ref={list}>{messages}</MessageList>
 *   list.current?.scrollToEnd();
 */
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { useCalm } from "@/lib/motion/use-calm";

/** Scrolled up more than this, in px, and it stops following. */
export const PIN_SLACK_PX = 40;
/** Scroll events this soon after our own scroll are ours, not hers. */
const OWN_SCROLL_MS = 80;
const SMOOTH_MS = 450;

export type MessageListHandle = {
  /** Pins to the bottom and scrolls there (smoothly unless calm). */
  scrollToEnd: () => void;
  isPinned: () => boolean;
};

export type MessageListProps = {
  children: ReactNode;
  /** Called when following the bottom turns on or off. */
  onPinnedChange?: (pinned: boolean) => void;
  "aria-label"?: string;
  className?: string;
  ref?: Ref<MessageListHandle>;
};

export function MessageList({
  children,
  onPinnedChange,
  "aria-label": label = "Chat",
  className = "",
  ref,
}: MessageListProps) {
  const calm = useCalm();
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const ownScrollAt = useRef(0);
  const smoothUntil = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChange = useRef(onPinnedChange);
  useEffect(() => {
    onChange.current = onPinnedChange;
  });

  const setPinned = useCallback((next: boolean) => {
    if (pinned.current === next) return;
    pinned.current = next;
    onChange.current?.(next);
  }, []);

  /** Follows the bottom, if pinned and not in the middle of a smooth scroll. */
  const pin = useCallback(() => {
    const el = box.current;
    if (!el || !pinned.current) return;
    const now = performance.now();
    if (smoothUntil.current > now) return;
    ownScrollAt.current = now;
    el.scrollTop = el.scrollHeight;
  }, []);

  const scrollToEnd = useCallback(() => {
    const el = box.current;
    if (!el) return;
    setPinned(true);
    const now = performance.now();
    ownScrollAt.current = now;
    if (calm || typeof el.scrollTo !== "function") {
      el.scrollTop = el.scrollHeight;
      return;
    }
    smoothUntil.current = now + SMOOTH_MS;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // Anything that arrived during the smooth scroll is caught up after it.
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      settle.current = null;
      pin();
    }, SMOOTH_MS + 20);
  }, [calm, pin, setPinned]);

  useEffect(
    () => () => {
      if (settle.current !== null) clearTimeout(settle.current);
    },
    [],
  );

  useImperativeHandle(ref, () => ({ scrollToEnd, isPinned: () => pinned.current }), [scrollToEnd]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const now = performance.now();
    if (now - ownScrollAt.current <= OWN_SCROLL_MS || smoothUntil.current >= now) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK_PX);
  };

  // Growing content (a new message, a streamed line, a card) keeps it at the bottom.
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => pin());
    observer.observe(el);
    return () => observer.disconnect();
  }, [pin]);

  // And so does every render of the list itself.
  useLayoutEffect(() => {
    pin();
  });

  return (
    <div
      ref={box}
      role="log"
      aria-label={label}
      tabIndex={0}
      onScroll={onScroll}
      className={`min-h-0 flex-1 overflow-y-auto overscroll-contain bg-paper outline-none focus-visible:ring-2 focus-visible:ring-ink-3 focus-visible:ring-inset ${className}`.trim()}
    >
      <div ref={content} className="flex flex-col gap-5 px-[var(--pad)] py-6">
        {children}
      </div>
    </div>
  );
}

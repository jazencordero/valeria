"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import { useMotionMode } from "@/lib/motion/use-calm";

/** Prototype `.is-scrolled`: a hairline plus a soft shadow under the header. */
const SCROLLED_SHADOW =
  "0 1px 0 var(--line), 0 10px 18px -14px color-mix(in oklch, var(--ink) 40%, transparent)";

type StickyHeaderProps = HTMLAttributes<HTMLElement> & {
  /** Scroll distance (px) after which the shadow shows. Prototype: 4. */
  threshold?: number;
  /**
   * Smallest top padding. The header uses this or the phone's top safe
   * area, whichever is larger. Default "0px".
   */
  padTop?: string;
};

function scrollParentOf(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const { overflowY } = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(overflowY)) return node;
    node = node.parentElement;
  }
  return null; // the page itself scrolls
}

/**
 * A header that sticks to the top of its scrolling parent and gains a hairline
 * and soft shadow once that parent has scrolled more than `threshold` px.
 * Finds the nearest scrolling ancestor itself, or uses the page.
 */
export function StickyHeader({
  threshold = 4,
  padTop = "0px",
  className = "",
  style,
  children,
  ...rest
}: StickyHeaderProps) {
  const ref = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const mode = useMotionMode();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const parent = scrollParentOf(el);
    const target: HTMLElement | Window = parent ?? window;
    const read = () =>
      setScrolled(
        (parent ? parent.scrollTop : window.scrollY) > threshold,
      );
    read();
    target.addEventListener("scroll", read, { passive: true });
    return () => target.removeEventListener("scroll", read);
  }, [threshold]);

  const merged: CSSProperties = {
    position: "sticky",
    top: 0,
    zIndex: 5,
    background: "var(--surface)",
    paddingTop: `max(${padTop}, env(safe-area-inset-top, 0px))`,
    boxShadow: scrolled ? SCROLLED_SHADOW : "none",
    transition:
      mode === "instant" ? "none" : "box-shadow var(--t-quick) var(--e-out)",
    ...style,
  };

  return (
    <header
      ref={ref}
      data-scrolled={scrolled ? "true" : "false"}
      className={className}
      style={merged}
      {...rest}
    >
      {children}
    </header>
  );
}

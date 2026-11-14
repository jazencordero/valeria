"use client";

/**
 * Makes everything outside one element `inert` while `active` is true, so
 * clicks, focus and screen readers stay inside it. Source: prototype
 * main-flow.html JS 4771-4786 (applyTrap).
 *
 *   const keepRef = useInertOthers(open);
 *   <div ref={keepRef}>...</div>
 *
 * Walks from the kept element up to <body> and marks every sibling on the way
 * `inert` plus `aria-hidden`. Elements that were already inert (an outer
 * view doing the same) are left alone, so layers can stack and unwind.
 */
import { useEffect, useRef, type RefObject } from "react";

const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "LINK", "META", "NOSCRIPT"]);

/** Marks the siblings of `keep` and of each of its ancestors. Returns an undo. */
export function inertOthers(keep: Element): () => void {
  const changed: HTMLElement[] = [];
  let node: Element | null = keep;
  while (node && node !== document.body && node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (SKIP.has(sibling.tagName) || sibling.inert) continue;
      sibling.inert = true;
      sibling.setAttribute("aria-hidden", "true");
      changed.push(sibling);
    }
    node = node.parentElement;
  }
  return () => {
    for (const el of changed) {
      el.inert = false;
      el.removeAttribute("aria-hidden");
    }
  };
}

export function useInertOthers<T extends HTMLElement = HTMLDivElement>(
  active: boolean,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const keep = ref.current;
    if (!active || !keep) return;
    return inertOthers(keep);
  }, [active]);
  return ref;
}

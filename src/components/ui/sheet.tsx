"use client";

/**
 * Sheet: a modal panel. Source: prototype main-flow.html CSS 929-957 (.scrim,
 * .sheet, .handle), JS 4551-4573 (panelIn/panelOut) and 4771-4786 (applyTrap).
 *
 * Under 700 px it slides up from the bottom (320 ms in, 260 ms out). From
 * 700 px it is a centred dialog that fades and rises 8 px. The scrim fades
 * (200 ms in, 260 ms out). With reduced motion both are a 150 ms fade.
 *
 * Built by hand (role="dialog", aria-modal, own focus trap) rather than on
 * native <dialog>, because `locked` must be able to ignore Escape every time
 * and native Escape handling can't promise that, and so the panel and scrim
 * can animate out.
 *
 * - Escape and a tap on the scrim call onClose, unless `locked`.
 * - Tab and Shift+Tab wrap inside the panel.
 * - Everything else on the page is `inert` while it is open.
 * - Focus goes into the panel on open and back to the opener on close.
 */
import { AnimatePresence, motion, type MotionProps } from "motion/react";
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useInertOthers } from "@/lib/a11y/inert";
import { duration, ease } from "@/lib/motion/tokens";
import { sheetUp, fade } from "@/lib/motion/transitions";
import { useMotionMode, type MotionMode } from "@/lib/motion/use-calm";

export type SheetProps = {
  open: boolean;
  /** Called on Escape or a scrim tap (unless locked). Set `open` false here. */
  onClose: () => void;
  /** Ignore Escape and scrim taps, e.g. while sending. */
  locked?: boolean;
  /** Heading shown at the top; also names the dialog. */
  title?: ReactNode;
  /** Names the dialog when there is no visible title. */
  "aria-label"?: string;
  /** Element to focus on open. Defaults to the panel itself. */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  children?: ReactNode;
  "data-testid"?: string;
};

/** Width from which the sheet becomes a centred dialog. */
export const SHEET_WIDE_QUERY = "(min-width: 700px)";

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest("[hidden],[inert]") && el.tabIndex >= 0,
  );
}

function subscribeWide(onChange: () => void) {
  const media = window.matchMedia(SHEET_WIDE_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(SHEET_WIDE_QUERY).matches,
    () => false,
  );
}

const noop = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

type Anim = Pick<MotionProps, "initial" | "animate" | "exit" | "transition">;

const OUT_MS = 0.26;

function scrimMotion(mode: MotionMode): Anim {
  if (mode !== "full") return fade(mode);
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0, transition: { duration: OUT_MS, ease: "linear" } },
    transition: { duration: 0.2, ease: "linear" },
  };
}

function panelMotion(mode: MotionMode, wide: boolean): Anim {
  if (mode !== "full") return sheetUp(mode);
  const out = { duration: OUT_MS, ease: ease.inout };
  if (wide) {
    return {
      initial: { opacity: 0, y: 8 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: 8, transition: out },
      transition: { duration: duration.base, ease: ease.out },
    };
  }
  return {
    initial: { y: "100%" },
    animate: { y: 0 },
    exit: { y: "100%", transition: out },
    transition: { duration: 0.32, ease: ease.out },
  };
}

export function Sheet({
  open,
  onClose,
  locked = false,
  title,
  "aria-label": ariaLabel,
  initialFocus,
  className = "",
  children,
  "data-testid": testId,
}: SheetProps) {
  const mounted = useMounted();
  const mode = useMotionMode();
  const wide = useWide();
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);

  // Declared before the focus effect: on close its cleanup lifts `inert`
  // first, so the opener can take focus again.
  const layerRef = useInertOthers<HTMLDivElement>(open && mounted);

  const requestClose = () => {
    if (!locked) onClose();
  };

  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    const panel = panelRef.current;
    if (!panel) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!locked) onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const list = focusables(panel);
    const active = document.activeElement;
    if (list.length === 0) {
      e.preventDefault();
      panel.focus({ preventScroll: true });
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const inside = active instanceof Node && panel.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first || active === panel) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // Focus in on open, back to the opener on close. Also the key handler,
  // a focus guard and the scroll lock.
  useEffect(() => {
    if (!open || !mounted) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = initialFocus?.current ?? panelRef.current;
    target?.focus({ preventScroll: true });

    const keydown = (e: KeyboardEvent) => onKeyDown(e);
    const focusin = (e: FocusEvent) => {
      const panel = panelRef.current;
      if (panel && e.target instanceof Node && !panel.contains(e.target)) {
        panel.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin);

    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin);
      root.style.overflow = overflow;
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
    // initialFocus is read once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  if (!mounted) return null;

  const scrim = scrimMotion(mode);
  const panel = panelMotion(mode, wide);

  return createPortal(
    <div ref={layerRef} data-sheet-layer="">
      <AnimatePresence>
        {open && (
          <motion.div
            key="scrim"
            {...scrim}
            aria-hidden="true"
            data-testid={testId ? `${testId}-scrim` : "sheet-scrim"}
            className="fixed inset-0 z-50 bg-[var(--scrim)]"
            onClick={() => requestClose()}
          />
        )}
        {open && (
          <motion.div
            key="frame"
            exit={{ opacity: 1 }}
            className="pointer-events-none fixed inset-0 z-[51] flex items-end justify-center min-[700px]:items-center min-[700px]:p-6"
          >
            <motion.section
              {...panel}
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={title ? titleId : undefined}
              aria-label={title ? undefined : ariaLabel}
              tabIndex={-1}
              data-testid={testId}
              data-layout={wide ? "centred" : "bottom"}
              className={
                "pointer-events-auto relative w-full overflow-y-auto overscroll-contain bg-surface text-ink outline-none " +
                "max-h-[92dvh] rounded-t-[26px] shadow-[var(--shadow-sheet)] " +
                "px-[var(--pad)] pt-2 pb-[max(20px,env(safe-area-inset-bottom,0px))] " +
                "min-[700px]:max-h-[calc(100dvh-48px)] min-[700px]:max-w-[480px] min-[700px]:rounded-[26px] " +
                "min-[700px]:px-7 min-[700px]:pt-7 min-[700px]:pb-7 min-[700px]:shadow-[var(--shadow-lift)] " +
                className
              }
            >
              <div
                aria-hidden="true"
                className="mx-auto mt-[2px] mb-5 h-1 w-9 rounded-full bg-line min-[700px]:hidden"
              />
              {title ? (
                <h2 id={titleId} className="type-h22 mb-2">
                  {title}
                </h2>
              ) : null}
              {children}
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

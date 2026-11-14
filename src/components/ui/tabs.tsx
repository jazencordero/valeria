"use client";

/**
 * Tabs: one shared piece for the exam page and the course grade pages.
 * A pill track with equal columns and a surface-coloured marker that springs
 * to the chosen tab (250 ms, no bounce). The old panel fades and slides 8 px
 * away, the new one slides in (200 ms). Instant when calm.
 *
 * Keyboard: only the active tab is in the Tab order; Left and Right wrap,
 * Home and End jump. `memoryKey` keeps the chosen tab in sessionStorage.
 * On phones the track sticks to the top of the scrolling area (`stickyTop`).
 * With more than three tabs, phones get a sideways-scrolling track (96 px per
 * tab) with faded edges, and the chosen tab scrolls itself into view.
 *
 * Source: prototype merged.html CSS 1382-1390, JS 5886-5933;
 * merged-2.html CSS 1515-1519, JS 6023-6027.
 * Cut: two to five tabs.
 */
import { animate, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

export type TabItem = {
  /** Stable id, used for memory and `onShown`. */
  id: string;
  label: string;
  /** Small count after the label, for example Lectures 4. */
  count?: number;
  content: ReactNode;
};

export type TabsProps = {
  /** Two to five tabs. */
  tabs: TabItem[];
  /** Spoken name of the tab list. */
  label?: string;
  /** Tab id shown first when nothing is remembered. Defaults to the first. */
  defaultTab?: string;
  /** Remembers the chosen tab in sessionStorage under this key. */
  memoryKey?: string;
  /** Phones: how far from the top of the scrolling area the track sticks, in px. */
  stickyTop?: number;
  /** Fires the first time each panel appears (for charts that draw on first view). */
  onShown?: (tabId: string) => void;
  /** Fires when the chosen tab changes. */
  onChange?: (tabId: string) => void;
  className?: string;
};

const STORAGE_PREFIX = "ready.tabs.";

function readMemory(key: string | undefined): string | null {
  if (!key) return null;
  try {
    return window.sessionStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return null;
  }
}

function writeMemory(key: string | undefined, id: string) {
  if (!key) return;
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + key, id);
  } catch {
    // Storage can be blocked (private mode); the tab still works.
  }
}

const noopSubscribe = () => () => {};

export function Tabs({
  tabs,
  label = "Sections",
  defaultTab,
  memoryKey,
  stickyTop = 0,
  onShown,
  onChange,
  className = "",
}: TabsProps) {
  const gid = useId();
  const mode = useMotionMode();
  const n = tabs.length;
  const many = n > 3;

  // Remembered tab, read on the client only so the server render stays plain.
  const remembered = useSyncExternalStore(
    noopSubscribe,
    () => readMemory(memoryKey),
    () => null,
  );

  const indexOf = (id: string | null | undefined) => {
    if (id == null) return -1;
    return tabs.findIndex((t) => t.id === id);
  };

  const [choice, setChoice] = useState<number | null>(null);
  // While the old panel leaves, it stays shown; null means "show the active one".
  const [leaving, setLeaving] = useState<number | null>(null);

  const fallback = Math.max(0, indexOf(defaultTab));
  const rememberedIndex = indexOf(remembered);
  const active = Math.min(
    n - 1,
    choice ?? (rememberedIndex >= 0 ? rememberedIndex : fallback),
  );
  const shown = leaving ?? active;

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const panelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const barRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const token = useRef(0);
  const enterDir = useRef(0);
  const seen = useRef(new Set<string>());
  const userChose = useRef(false);

  const select = useCallback(
    (i: number, focus: boolean) => {
      if (focus) tabRefs.current[i]?.focus({ preventScroll: true });
      if (i === active) return;
      const from = active;
      const dir = i > from ? 1 : -1;
      const tok = ++token.current;
      userChose.current = true;
      setChoice(i);
      writeMemory(memoryKey, tabs[i].id);
      onChange?.(tabs[i].id);

      const fromEl = panelRefs.current[from];
      if (mode !== "full" || !fromEl || leaving !== null) {
        enterDir.current = mode === "full" ? dir : 0;
        setLeaving(null);
        return;
      }
      setLeaving(from);
      animate(
        fromEl,
        { opacity: [1, 0], x: [0, -8 * dir] },
        { duration: 0.1, ease: "linear" },
      ).then(() => {
        if (token.current !== tok) return;
        fromEl.style.opacity = "";
        fromEl.style.transform = "";
        enterDir.current = dir;
        setLeaving(null);
      });
    },
    [active, leaving, memoryKey, mode, onChange, tabs],
  );

  // The new panel slides in once it is in the layout.
  useEffect(() => {
    const dir = enterDir.current;
    enterDir.current = 0;
    const el = panelRefs.current[shown];
    if (!dir || !el) return;
    const controls = animate(
      el,
      { opacity: [0, 1], x: [8 * dir, 0] },
      { duration: 0.2, ease: ease.out },
    );
    return () => controls.stop();
  }, [shown]);

  // First view of each panel.
  useEffect(() => {
    const id = tabs[shown]?.id;
    if (!id || seen.current.has(id)) return;
    seen.current.add(id);
    onShown?.(id);
  }, [shown, tabs, onShown]);

  // Keep the chosen tab in view when the track scrolls sideways.
  useEffect(() => {
    const bar = barRef.current;
    const list = listRef.current;
    const tab = tabRefs.current[active];
    if (!bar || !list || !tab) return;
    if (bar.scrollWidth <= bar.clientWidth + 1) return;
    const left = Math.max(
      0,
      tab.offsetLeft + list.offsetLeft - (bar.clientWidth - tab.offsetWidth) / 2,
    );
    const smooth = userChose.current && mode === "full";
    if (smooth) bar.scrollTo({ left, behavior: "smooth" });
    else bar.scrollLeft = left;
  }, [active, mode]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (i + 1) % n;
    else if (e.key === "ArrowLeft") next = (i - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next === null) return;
    e.preventDefault();
    select(next, true);
  };

  // Restoring a remembered tab after load is instant; only a user choice moves.
  const markerTransition =
    mode === "full" && choice !== null
      ? ({ type: "spring", bounce: 0, duration: 0.25 } as const)
      : ({ duration: 0 } as const);

  const fade =
    "max-[699px]:[mask-image:linear-gradient(to_right,transparent_0,black_14px,black_calc(100%-28px),transparent_100%)]";

  return (
    <div className={className}>
      <div
        ref={barRef}
        data-testid="tabs-bar"
        style={{ "--tabs-top": `${stickyTop}px` } as CSSProperties}
        className={
          "mt-4 max-[699px]:sticky max-[699px]:top-[var(--tabs-top)] max-[699px]:z-[4] " +
          "max-[699px]:-mx-4 max-[699px]:mt-3 max-[699px]:bg-surface max-[699px]:px-4 max-[699px]:py-2 " +
          (many
            ? "max-[699px]:overflow-x-auto max-[699px]:[scrollbar-width:none] max-[699px]:[&::-webkit-scrollbar]:hidden " +
              fade
            : "")
        }
      >
        <div
          ref={listRef}
          role="tablist"
          aria-label={label}
          style={{ "--n": n } as CSSProperties}
          className={
            "relative grid grid-cols-[repeat(var(--n),minmax(0,1fr))] rounded-full border border-line bg-paper p-[3px] " +
            (many
              ? "max-[699px]:w-max max-[699px]:grid-cols-[repeat(var(--n),96px)]"
              : "")
          }
        >
          <motion.span
            aria-hidden="true"
            data-testid="tabs-marker"
            className="absolute top-[3px] bottom-[3px] left-[3px] w-[calc((100%-6px)/var(--n))] rounded-full bg-surface shadow-[var(--shadow-card)]"
            initial={false}
            animate={{ x: `${active * 100}%` }}
            transition={markerTransition}
          />
          {tabs.map((tab, i) => {
            const on = i === active;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${gid}-t${i}`}
                aria-selected={on}
                aria-controls={`${gid}-p${i}`}
                tabIndex={on ? 0 : -1}
                onClick={() => select(i, false)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className={
                  "relative z-[1] min-h-11 whitespace-nowrap rounded-full border-0 bg-transparent px-2.5 text-[14px] " +
                  "transition-colors duration-quick ease-out " +
                  (on ? "font-semibold text-ink" : "font-medium text-ink-2")
                }
              >
                {tab.label}
                {tab.count != null && " "}
                {tab.count != null && (
                  <span className="ml-0.5 font-mono text-[11px] text-ink-3">
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {tabs.map((tab, i) => (
        <div
          key={tab.id}
          ref={(el) => {
            panelRefs.current[i] = el;
          }}
          role="tabpanel"
          id={`${gid}-p${i}`}
          aria-labelledby={`${gid}-t${i}`}
          tabIndex={0}
          hidden={i !== shown}
          className="pt-5 outline-none [&>*+*]:mt-5"
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}

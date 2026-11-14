"use client";

/**
 * Sources: the course files attached to an assignment.
 * Source: prototype main-flow.html HTML 1634-1657 (.sources, .chips-wrap),
 * CSS 837-870 (.sources, .chips, .chip.src, .chip-pop), JS 4223-4233 (toggleChip).
 *
 * Two pieces, placed by the workspace layout:
 *  - `SourcesColumn`: from 700 px, a left column titled "Sources" listing each
 *    file (icon, mono name, "From <LMS> · <course>"). Hidden under 700 px.
 *  - `SourceChips`: under 700 px, a row of chips above the chat. Each chip
 *    toggles a small popover with the same line and an "Open" link to
 *    `/api/files/<id>`. One popover at a time; Escape closes it and returns
 *    focus to its chip; a click outside closes it. Hidden from 700 px.
 * A file whose text could not be read says "Not readable yet" in the meta line.
 * Plain data in, no fetching. Sources cannot be added or removed here.
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { fade } from "@/lib/motion/transitions";
import { duration, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

export type SourceIconKind = "doc" | "data" | "image";

export type SourceFile = {
  id: string;
  /** File name as it appears in the LMS, e.g. "A3_brief.pdf". */
  name: string;
  /** MIME type; picks the icon unless `icon` is given. */
  mime?: string;
  icon?: SourceIconKind;
  /** Course name, e.g. "Forecasting Methods". */
  course: string;
  /** False when the file's text could not be read (yet). */
  readable: boolean;
};

export type SourcesProps = {
  files: readonly SourceFile[];
  /** The school's LMS name from `src/lib/schools.ts`, e.g. "MyCourses". */
  lmsName: string;
  className?: string;
};

export function iconKindFor(file: Pick<SourceFile, "mime" | "icon" | "name">): SourceIconKind {
  if (file.icon) return file.icon;
  const mime = (file.mime ?? "").toLowerCase();
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (
    mime.includes("csv") ||
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    ["csv", "xls", "xlsx", "ods", "tsv"].includes(ext)
  )
    return "data";
  return "doc";
}

export function sourceMeta(file: Pick<SourceFile, "course" | "readable">, lmsName: string): string {
  const line = `From ${lmsName} · ${file.course}`;
  return file.readable ? line : `${line} · Not readable yet`;
}

export function fileHref(id: string): string {
  return `/api/files/${encodeURIComponent(id)}`;
}

function SourceIcon({ kind }: { kind: SourceIconKind }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      {kind === "image" ? (
        <>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M4 16l4.5-4.5L13 16l2.5-2.5L20 18" />
          <circle cx="15.5" cy="9.5" r="1.25" />
        </>
      ) : (
        <>
          <path d="M7 3.5h6.5L18 8v12.5H7z" />
          <path d="M13.5 3.5V8H18" />
          {kind === "data" ? <path d="M9.5 12.5h5M9.5 15.5h5M12 11v6" /> : null}
        </>
      )}
    </svg>
  );
}

/** Wide screens: the left "Sources" column. */
export function SourcesColumn({ files, lmsName, className = "" }: SourcesProps) {
  return (
    <aside
      aria-label="Sources"
      className={
        "hidden w-[260px] flex-none overflow-y-auto border-r border-line bg-surface px-5 pt-6 pb-6 " +
        "min-[700px]:block " +
        className
      }
    >
      <p className="mono uppercase tracking-[0.08em] text-ink-3">Sources</p>
      <ul className="mt-3 grid list-none gap-4">
        {files.map((f) => (
          <li key={f.id} className="flex items-start gap-2.5 text-ink-2">
            <span className="mt-px">
              <SourceIcon kind={iconKindFor(f)} />
            </span>
            <div className="min-w-0">
              <p className="mono text-ink [overflow-wrap:anywhere]">{f.name}</p>
              <p className="mt-0.5 text-[13px] leading-[1.35] text-ink-3">{sourceMeta(f, lmsName)}</p>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/** Narrow screens: chips above the chat, each with a small popover. */
export function SourceChips({ files, lmsName, className = "" }: SourcesProps) {
  const mode = useMotionMode();
  const [openId, setOpenId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const popId = useId();
  const open = files.find((f) => f.id === openId) ?? null;

  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      const chip = chipRefs.current.get(openId);
      setOpenId(null);
      chip?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpenId(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [openId]);

  const popMotion =
    mode === "full"
      ? {
          initial: { opacity: 0, y: -4 },
          animate: { opacity: 1, y: 0 },
          exit: { opacity: 0, y: -4 },
          transition: { duration: duration.quick, ease: ease.out },
        }
      : fade(mode);

  if (files.length === 0) return null;

  return (
    <div ref={wrapRef} className={"border-b border-line bg-surface min-[700px]:hidden " + className}>
      <div
        role="group"
        aria-label="Sources"
        className="flex gap-1.5 overflow-x-auto px-[var(--pad)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {files.map((f) => {
          const expanded = f.id === openId;
          return (
            <button
              key={f.id}
              ref={(el) => {
                if (el) chipRefs.current.set(f.id, el);
                else chipRefs.current.delete(f.id);
              }}
              type="button"
              aria-expanded={expanded}
              aria-controls={expanded ? popId : undefined}
              onClick={() => setOpenId(expanded ? null : f.id)}
              className="group inline-flex min-h-11 flex-none items-center rounded-full border-0 bg-transparent p-0"
            >
              <span
                className={
                  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-solid border-line " +
                  "bg-surface px-3 font-mono text-[12px] tracking-[0.02em] text-ink-2 " +
                  "transition-[border-color,color] duration-quick ease-out motion-reduce:duration-150 " +
                  "group-hover:text-ink group-aria-expanded:border-ink-3 group-aria-expanded:text-ink"
                }
              >
                <SourceIcon kind={iconKindFor(f)} />
                {f.name}
              </span>
            </button>
          );
        })}
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="pop"
            id={popId}
            role="dialog"
            aria-label={open.name}
            {...popMotion}
            className="flex items-baseline gap-3 px-[var(--pad)] pb-3"
          >
            <p className="min-w-0 flex-1 text-[13px] leading-[1.35] text-ink-3">{sourceMeta(open, lmsName)}</p>
            <a
              href={fileHref(open.id)}
              target="_blank"
              rel="noopener"
              className="flex-none text-[13px] font-medium text-ink underline decoration-line underline-offset-4 hover:decoration-ink"
            >
              Open<span className="sr-only"> {open.name}</span>
            </a>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

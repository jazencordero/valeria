"use client";

/**
 * Lecture reader: the readable page Ready writes from a lecture's slides.
 * Source: prototype merged.html CSS 1038-1089 (.lec-*, .seg, .breath, .terms,
 * .slide-grid), JS 5442-5493 (lecturePageHTML, renderLecNotes, setLecMode).
 *
 * Four states, picked by `status`:
 *  - "ready": kicker, title, meta (read time, "From n slides", the file chip
 *    that opens the original through `/api/files/<id>`) and a three-way view
 *    control Read | Slides n | Notes n.
 *      Read: "IN ONE BREATH" box, the sections (heading, paragraphs, lists,
 *      definition lists, KEY TERMS pills, mono slide source) and an end block
 *      with the read mark, "Practise this lecture" (or the disabled "No cards
 *      for this one yet") and "Next: Lecture n".
 *      Slides: a grid of slide titles and "The original file stays in <LMS>."
 *      Notes: the `notes` slot; with no notes, the pencil and an empty line.
 *  - "not-posted": cup doodle, "Not posted in <LMS> yet. It opens <day>."
 *  - "writing": "Ready is reading these slides..." and a link to the original.
 *
 * The view control is a tab list (arrow keys, Home, End). Switching views
 * fades the new panel in and lifts it 4 px over 200 ms; no motion when the
 * user prefers reduced motion or the test switch is on.
 *
 * Teaching parts (M9-26), all optional, so a page without them reads as before:
 *  - "Start here" at the top of the text: open while the lecture is unread
 *    (`read` false when the reader mounts), closed once it has been read.
 *  - Per section, under the heading: KEY POINTS, always visible, in a box.
 *    Under the main text, three rows that stay closed until she opens them:
 *    "Explain it from the start", "Worked example" (title, numbered steps,
 *    the result in its own box) and "If you're stuck" (each question opens
 *    its own answer).
 *  - The meta line reads "6 min · 11 with all the help" when the page gives
 *    both times (and the second is the larger); otherwise "6 min read".
 * Every closed part is a `<button>` with `aria-expanded` and `aria-controls`.
 * A part opens downward from its button, so nothing above it moves and the
 * reading position stays where it is. Opening grows the part over 220 ms;
 * with reduced motion it fades in without growing, with the test switch it
 * is simply there. Closing is immediate. A closed part's content is not in
 * the page; an open one is marked `data-lec-help` so the page can leave it
 * out of the reading progress. What is open is kept while she switches
 * between Read, Slides and Notes; nothing about it is stored.
 *
 * Plain data in, no fetching. The LMS name is a prop (`src/lib/schools.ts`).
 * Cut: slide thumbnails, figures, highlights, the sticky back header with the
 * reading progress bar, and "Ask about this lecture" (M9-22).
 */
import "./reader.css";
import { motion } from "motion/react";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Doodle } from "@/components/doodle";
import { DoodlePencil } from "@/components/doodle-pencil";
import { Button } from "@/components/ui/button";
import { fileHref } from "@/components/work/sources";
import { calmDurationMs, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

// ---------------------------------------------------------------------------
// Data

/** One block of a section's body. */
export type LectureBlock =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "dl"; items: { term: string; def: string }[] };

export type LectureSection = {
  heading: string;
  blocks: LectureBlock[];
  /** Shown as KEY TERMS pills under the section. */
  terms?: string[];
  /** Which slides the section came from, e.g. "SLIDES 4-9". Shown in mono. */
  source: string;
  /** Two to five sentences, always visible above the text. */
  keyPoints?: string[];
  /** "Explain it from the start": the same idea for someone who never saw it. */
  fromScratch?: LectureBlock[];
  /** "Worked example". */
  example?: { title: string; steps: string[]; result: string };
  /** "If you're stuck": questions, each with its own answer. */
  stuck?: { q: string; a: string }[];
};

/** The labels of the parts that open on request (M9-26). */
export const HELP_LABELS = {
  start: "Start here",
  scratch: "Explain it from the start",
  example: "Worked example",
  stuck: "If you're stuck",
} as const;

/** "6 min read", or "6 min · 11 with all the help" when the page gives both times. */
export function readingTime(minutes: number, minutesWithHelp?: number | null): string {
  return minutesWithHelp && minutesWithHelp > minutes ? `${minutes} min · ${minutesWithHelp} with all the help` : `${minutes} min read`;
}

export type LectureFile = {
  /** Course file id; the chip links to `/api/files/<id>`. */
  id: string;
  /** File name as in the LMS, e.g. "L5_portfolio.pdf". */
  name: string;
};

export type LectureView = "read" | "slides" | "notes";

export type LectureReaderProps = {
  /** Course name for the kicker, e.g. "Strategic IT Management". Shown in capitals. */
  course: string;
  /** Lecture number. */
  n: number;
  title: string;
  /** The school's LMS name, e.g. "MyCourses". */
  lmsName: string;
  /** "ready" has a page; "not-posted" is still locked in the LMS; "writing" is being made. */
  status: "ready" | "not-posted" | "writing";
  /** The original file. Missing while the lecture is not posted. */
  file?: LectureFile | null;
  /** Not posted: the day it opens, as shown, e.g. "Mon 16 Nov". Says "soon" when missing. */
  opensOn?: string | null;
  /** Ready: reading time of the main text, in minutes. */
  minutes?: number;
  /** Ready: reading time with every piece of help open. */
  minutesWithHelp?: number | null;
  /** Ready: the "Start here" blocks. Missing or empty: no such part. */
  startHere?: LectureBlock[];
  /** Ready: how many slides the page was written from. */
  slideCount?: number;
  /** Ready: the summary in the "IN ONE BREATH" box. */
  breath?: string;
  sections?: LectureSection[];
  /** Slide titles in order; slide numbers are the position, starting at 1. */
  slideTitles?: string[];
  /** True once the lecture is marked read on the course path. */
  read?: boolean;
  /** Cards from this lecture. 0 or missing shows the disabled button. */
  cards?: number;
  /** Where "Practise this lecture" goes. */
  practiseHref?: string;
  /** The next lecture, when there is one. */
  next?: { n: number; href: string } | null;
  /** Count on the Notes tab. */
  notesCount?: number;
  /** The Notes view's content (note cards come from another ticket). Empty state when missing. */
  notes?: ReactNode;
  /** View shown first. Defaults to "read". */
  defaultView?: LectureView;
  className?: string;
};

export function cardCount(n: number): string {
  return `${n} ${n === 1 ? "card" : "cards"}`;
}

// ---------------------------------------------------------------------------
// Pieces

function FileIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3.5h6.5L18 8v12.5H7z" />
      <path d="M13.5 3.5V8H18" />
    </svg>
  );
}

function FileChip({ file }: { file: LectureFile }) {
  return (
    <a
      className="lec-file"
      href={fileHref(file.id)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open the original file, ${file.name}`}
    >
      <span className="lec-file-pill">
        <FileIcon />
        <span className="mono">{file.name}</span>
      </span>
    </a>
  );
}

function Block({ block }: { block: LectureBlock }) {
  if (block.kind === "p") return <p>{block.text}</p>;
  if (block.kind === "ul")
    return (
      <ul>
        {block.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    );
  return (
    <dl className="lec-deflist">
      {block.items.map((item, i) => (
        <div key={i}>
          <dt>{item.term}</dt>
          <dd>{item.def}</dd>
        </div>
      ))}
    </dl>
  );
}

function Chevron() {
  return (
    <svg className="ic lec-help-chev" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6.5 9.5L12 15l5.5-5.5" />
    </svg>
  );
}

const GROW_MS = 220;

/** An open part's content. Grows in when she has just opened it; never moves what is above. */
function HelpBody({ grow, top, children }: { grow: boolean; top: boolean; children: ReactNode }) {
  const mode = useMotionMode();
  const ref = useRef<HTMLDivElement | null>(null);
  // Only a part she opened plays; one that was open when the view was drawn does not.
  const [play] = useState(grow);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!play || !el || mode === "instant" || typeof el.animate !== "function") return;
    const anim =
      mode === "calm"
        ? el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: calmDurationMs, easing: "linear" })
        : el.animate(
            [
              { height: "0px", opacity: 0 },
              { height: `${el.offsetHeight}px`, opacity: 1 },
            ],
            { duration: GROW_MS, easing: `cubic-bezier(${ease.out.join(",")})` },
          );
    return () => anim.cancel();
  }, [play, mode]);

  return (
    <div ref={ref} className="lec-help-body" data-lec-help={top ? "" : undefined}>
      <div className="lec-help-in">{children}</div>
    </div>
  );
}

type HelpState = {
  isOpen: (key: string) => boolean;
  /** The part she opened last in this view; it is the one that grows in. */
  fresh: string | null;
  toggle: (key: string) => void;
  idOf: (key: string) => string;
};

/** One part that opens on request: a real button, then its content right under it. */
function Help({
  k,
  label,
  help,
  sub = false,
  children,
}: {
  k: string;
  label: string;
  help: HelpState;
  /** A question inside "If you're stuck". */
  sub?: boolean;
  children: ReactNode;
}) {
  const open = help.isOpen(k);
  const id = help.idOf(k);
  return (
    <div className={sub ? "lec-help-item lec-help-sub" : "lec-help-item"}>
      <button type="button" className="lec-help-btn" aria-expanded={open} aria-controls={id} onClick={() => help.toggle(k)}>
        <span>{label}</span>
        <Chevron />
      </button>
      <div id={id} className="lec-help-panel" hidden={!open}>
        {open ? (
          <HelpBody grow={help.fresh === k} top={!sub}>
            {children}
          </HelpBody>
        ) : null}
      </div>
    </div>
  );
}

function SectionHelp({ i, section, help }: { i: number; section: LectureSection; help: HelpState }) {
  const { fromScratch, example, stuck } = section;
  const hasScratch = !!fromScratch && fromScratch.length > 0;
  const hasStuck = !!stuck && stuck.length > 0;
  if (!hasScratch && !example && !hasStuck) return null;
  return (
    <div className="lec-help">
      {hasScratch ? (
        <Help k={`${i}:scratch`} label={HELP_LABELS.scratch} help={help}>
          {fromScratch.map((b, j) => (
            <Block key={j} block={b} />
          ))}
        </Help>
      ) : null}
      {example ? (
        <Help k={`${i}:example`} label={HELP_LABELS.example} help={help}>
          <p className="lec-ex-title">{example.title}</p>
          {example.steps.length ? (
            <ol className="lec-ex-steps">
              {example.steps.map((step, j) => (
                <li key={j}>{step}</li>
              ))}
            </ol>
          ) : null}
          <div className="lec-ex-result">
            <p className="mono">RESULT</p>
            <p>{example.result}</p>
          </div>
        </Help>
      ) : null}
      {hasStuck ? (
        <Help k={`${i}:stuck`} label={HELP_LABELS.stuck} help={help}>
          <div className="lec-stuck">
            {stuck.map((item, j) => (
              <Help key={j} k={`${i}:stuck:${j}`} label={item.q} help={help} sub>
                <p>{item.a}</p>
              </Help>
            ))}
          </div>
        </Help>
      ) : null}
    </div>
  );
}

function Top({ course, n, title }: { course: string; n: number; title: string }) {
  return (
    <>
      <p className="mono lec-kicker">
        LECTURE {n} · {course.toUpperCase()}
      </p>
      <h1 className="lec-h1" tabIndex={-1}>
        {title}
      </h1>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reader

const VIEWS: LectureView[] = ["read", "slides", "notes"];

export function LectureReader(props: LectureReaderProps) {
  const { course, n, title, lmsName, status, file, className = "" } = props;
  const root = className ? `lec-reader ${className}` : "lec-reader";

  if (status === "not-posted") {
    return (
      <div className={root}>
        <Top course={course} n={n} title={title} />
        <div className="lec-empty lec-soon">
          <Doodle name="cup" size={64} />
          <p>
            Not posted in {lmsName} yet. It opens {props.opensOn || "soon"}.
          </p>
        </div>
      </div>
    );
  }

  if (status === "writing") {
    return (
      <div className={root}>
        <Top course={course} n={n} title={title} />
        <div className="lec-empty lec-soon">
          <DoodlePencil size={56} />
          <p>Ready is reading these slides. The page will be here within a day.</p>
          {file ? <FileChip file={file} /> : null}
        </div>
      </div>
    );
  }

  return <ReadyReader {...props} />;
}

function ReadyReader({
  course,
  n,
  title,
  lmsName,
  file,
  minutes,
  minutesWithHelp,
  startHere = [],
  slideCount,
  breath,
  sections = [],
  slideTitles = [],
  read = false,
  cards = 0,
  practiseHref,
  next,
  notesCount = 0,
  notes,
  defaultView = "read",
  className = "",
}: LectureReaderProps) {
  const mode = useMotionMode();
  const [view, setView] = useState<LectureView>(defaultView);
  // Animate only views the user switches to, never the first paint.
  const [switched, setSwitched] = useState(false);
  const uid = useId();
  const tabRefs = useRef<Record<LectureView, HTMLButtonElement | null>>({
    read: null,
    slides: null,
    notes: null,
  });

  // Which parts are open. "Start here" starts open on a lecture she has not read yet.
  const [help, setHelp] = useState<{ open: ReadonlySet<string>; fresh: string | null }>(() => ({
    open: new Set(read ? [] : ["start"]),
    fresh: null,
  }));
  const helpState: HelpState = {
    isOpen: (key) => help.open.has(key),
    fresh: help.fresh,
    idOf: (key) => `${uid}-help-${key.replaceAll(":", "-")}`,
    toggle: (key) =>
      setHelp((h) => {
        const open = new Set(h.open);
        const opening = !open.has(key);
        if (opening) open.add(key);
        else open.delete(key);
        return { open, fresh: opening ? key : null };
      }),
  };

  const choose = (v: LectureView) => {
    if (v === view) return;
    setSwitched(true);
    setView(v);
    // Coming back to Read, open parts are simply there.
    setHelp((h) => (h.fresh === null ? h : { ...h, fresh: null }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = VIEWS.indexOf(view);
    let to: number | null = null;
    if (e.key === "ArrowRight") to = (i + 1) % VIEWS.length;
    else if (e.key === "ArrowLeft") to = (i - 1 + VIEWS.length) % VIEWS.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = VIEWS.length - 1;
    if (to === null) return;
    e.preventDefault();
    const v = VIEWS[to];
    choose(v);
    tabRefs.current[v]?.focus();
  };

  const tabLabel: Record<LectureView, ReactNode> = {
    read: "Read",
    slides: (
      <>
        Slides <span className="mono">{slideTitles.length}</span>
      </>
    ),
    notes: (
      <>
        Notes <span className="mono">{notesCount}</span>
      </>
    ),
  };

  const tabId = (v: LectureView) => `${uid}-tab-${v}`;
  const panelId = (v: LectureView) => `${uid}-panel-${v}`;
  const animate = switched && mode === "full";
  const hasCards = cards > 0 && !!practiseHref;

  let panel: ReactNode;
  if (view === "read") {
    panel = (
      <>
        <article className="lec-body" aria-label="Lecture text">
          {startHere.length ? (
            <div className="lec-help lec-start">
              <Help k="start" label={HELP_LABELS.start} help={helpState}>
                {startHere.map((b, j) => (
                  <Block key={j} block={b} />
                ))}
              </Help>
            </div>
          ) : null}
          {breath ? (
            <div className="lec-breath">
              <p className="mono">IN ONE BREATH</p>
              <p>{breath}</p>
            </div>
          ) : null}
          {sections.map((s, i) => {
            const hid = `${uid}-sec-${i}`;
            return (
              <section key={i} className="lec-sec" aria-labelledby={hid}>
                <h2 id={hid}>{s.heading}</h2>
                {s.keyPoints && s.keyPoints.length ? (
                  <div className="lec-key">
                    <p className="mono">KEY POINTS</p>
                    <ul>
                      {s.keyPoints.map((point, j) => (
                        <li key={j}>{point}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {s.blocks.map((b, j) => (
                  <Block key={j} block={b} />
                ))}
                <SectionHelp i={i} section={s} help={helpState} />
                {s.terms && s.terms.length ? (
                  <div className="lec-terms">
                    <span className="mono lec-terms-l">KEY TERMS</span>
                    {s.terms.map((t) => (
                      <span key={t} className="lec-term">
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
                <p className="mono lec-src">{s.source}</p>
              </section>
            );
          })}
        </article>
        <div className="lec-end">
          <p className="mono lec-readmark" aria-live="polite">
            {read ? "READ · MARKED ON YOUR PATH" : ""}
          </p>
          <div className="lec-actions">
            {hasCards ? (
              <Button variant="primary" size="lg" block href={practiseHref}>
                Practise this lecture
                <span className="mono lec-btn-count">{cardCount(cards)}</span>
              </Button>
            ) : (
              <Button variant="primary" size="lg" block disabled>
                No cards for this one yet
              </Button>
            )}
          </div>
          {next ? (
            <Button variant="text" size="md" href={next.href} className="lec-next">
              Next: Lecture {next.n}
            </Button>
          ) : null}
        </div>
      </>
    );
  } else if (view === "slides") {
    panel = (
      <>
        <ol className="lec-slide-grid">
          {slideTitles.map((t, i) => (
            <li key={i} className="lec-slide">
              <span className="mono">slide {i + 1}</span>
              <span>{t}</span>
            </li>
          ))}
        </ol>
        <p className="lec-note">The original file stays in {lmsName}.</p>
      </>
    );
  } else {
    panel = notes ? (
      <div className="lec-notes">{notes}</div>
    ) : (
      <div className="lec-empty lec-notes">
        <DoodlePencil size={56} />
        <p>No notes here yet. Write the thing you keep forgetting.</p>
      </div>
    );
  }

  return (
    <div className={className ? `lec-reader ${className}` : "lec-reader"}>
      <Top course={course} n={n} title={title} />
      <div className="lec-meta">
        {minutes ? <span className="mono">{readingTime(minutes, minutesWithHelp)}</span> : null}
        {slideCount ? <span className="mono">From {slideCount} slides</span> : null}
        {file ? <FileChip file={file} /> : null}
      </div>

      <div className="lec-seg" role="tablist" aria-label="View" onKeyDown={onKeyDown}>
        {VIEWS.map((v) => (
          <button
            key={v}
            ref={(el) => {
              tabRefs.current[v] = el;
            }}
            type="button"
            role="tab"
            id={tabId(v)}
            aria-selected={view === v}
            aria-controls={panelId(v)}
            tabIndex={view === v ? 0 : -1}
            onClick={() => choose(v)}
          >
            {tabLabel[v]}
          </button>
        ))}
      </div>

      <motion.div
        key={view}
        className="lec-panel"
        role="tabpanel"
        id={panelId(view)}
        aria-labelledby={tabId(view)}
        initial={animate ? { opacity: 0, y: 4 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: ease.out }}
      >
        {panel}
      </motion.div>
    </div>
  );
}

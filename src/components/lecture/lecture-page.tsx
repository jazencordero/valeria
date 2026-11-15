"use client";

/**
 * One lecture's page (M9-15): sticky header, the reader, its notes, reading
 * progress and marking it read, and "Practise this lecture".
 * Source: prototype merged-2.html JS 5497-5560 (lecturePageHTML,
 * renderLecNotes, setLecMode, lecProgress) and CSS 1039-1041 (.lec-head,
 * .lec-prog).
 *
 * - Header: "Back to <course>" (the course page), or "Back to exam" when the
 *   page was opened from an exam's Lectures tab (M9-23, `?from=exam:<uuid>`;
 *   anything else in `from` is ignored and the back link is built here from
 *   the id, never taken from the query), the course name in mono
 *   capitals and a 3 px reading progress bar along its bottom edge, the
 *   scroll fraction of the app's `<main id="main">` (M9-10's hook).
 * - The reader is M9-09's `LectureReader`. It keeps its own view; this page
 *   follows which tab is selected (its `aria-selected`) so only Read can mark
 *   the lecture read.
 * - Reading to the end (or 2.5 s on a page that does not scroll) calls
 *   `markRead` once; when it answers ok the end block reads
 *   "READ · MARKED ON YOUR PATH". A lecture read before is not marked again.
 * - "Practise this lecture" goes to `practiseHref` (GET /study/new with
 *   `lecture` and `return`) with `router.push`. The reader draws it as a
 *   link, so the link's own href is a plain "#practise" and the click is
 *   taken here: a link to the route handler would be prefetched, and a
 *   prefetch would start a session. No cards: the reader's disabled
 *   "No cards for this one yet".
 * - Notes: this lecture's note cards (M9-14's `NoteCard`), or the empty
 *   line, and "New note", which opens the notepad attached to this lecture
 *   (the notepad reads the page's path). A note made here arrives with the
 *   notepad's refresh; an edit shows at once (`NOTE_SAVED_EVENT`); delete
 *   hides the card at once.
 *
 * - Selecting text in Read view offers "Add note" (M9-16's `SelectNote`):
 *   the text gets a butter highlight, is stored (`saveHighlight`) and opens
 *   the notepad with it as the quote. Stored highlights are read when the
 *   page opens (`lectureHighlights`) and re-applied by matching the text.
 *
 * - Help that opens on request (M9-26, the reader's "Start here", "Explain it
 *   from the start", "Worked example", "If you're stuck"). "Start here" is
 *   open while `lecture.read` is false, the same read mark as everything
 *   else here. Reading progress counts the main text only: the progress hook
 *   reads its numbers from an unseen stand-in for the main column
 *   (`useMainTextScroll`) that is as tall as the page without its open help
 *   and scrolled as far as she is through the rest. With no help open the
 *   numbers are the main column's own. So opening help never moves the bar
 *   back, and the lecture is marked read at the end of the main text
 *   whatever is open. Selecting text works inside every part (they sit in
 *   the lecture text); a part's stored highlights are put back each time it
 *   opens, since a closed part's text is not in the page.
 *
 * Plain data in. `markRead`, `remove`, `saveHl` and `loadHl` default to the
 * real actions; a preview can pass stand-ins.
 *
 * - Opened from a stop on the course path, or from a row's number on an
 *   exam's Lectures tab, the page grows out of that circle (420 ms) and Back
 *   shrinks it into the circle again (380 ms), on the page and at the scroll
 *   it was opened from (M9-18, `LECTURE_PAGE`, `cardArrival` and
 *   `closeCardPage` in `@/lib/motion/shared`; calm: a fade, no View
 *   Transitions or a late page: a slide). A lecture marked read on this visit
 *   leaves `{ lectureRead: n }` for the course page, which plays the path's
 *   advance once the shrink is over. Opened any other way, Back goes to the
 *   course (or the exam) and shrinks into the stop there that carries this
 *   page's path, if there is one.
 *
 * Cut: "Ask about this lecture" (M9-22).
 */
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type RefObject,
} from "react";
import { markLectureRead, type MarkReadResult } from "@/app/(app)/courses/[id]/lectures/[n]/actions";
import {
  lectureHighlights,
  saveHighlight,
  type HighlightListResult,
  type HighlightSaveResult,
} from "@/app/(app)/courses/[id]/lectures/[n]/highlight-actions";
import { removeNote, type NoteRemoveResult } from "@/app/(app)/notes/actions";
import { DoodleDefs } from "@/components/doodle";
import { DoodlePencil } from "@/components/doodle-pencil";
import { LectureReader, type LectureView } from "@/components/lecture/reader";
import { SelectNote } from "@/components/lecture/select-note";
import { useReadProgress } from "@/components/lecture/use-read-progress";
import { NoteCard, type NoteCardData } from "@/components/notes/note-card";
import { NOTE_SAVED_EVENT, openNotepad, type NoteSavedDetail } from "@/components/notes/notepad";
import { Button } from "@/components/ui/button";
import { StickyHeader } from "@/components/ui/sticky-header";
import { LECTURE_PAGE, WORK_TRANSITION_CSS, cardArrival, closeCardPage, leaveCardPage } from "@/lib/motion/shared";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { LecturePageData } from "@/server/data/lecture";

/** The reader's link href for "Practise this lecture"; the click is taken by the page. */
export const PRACTISE_ANCHOR = "#practise";
export const NOTES_EMPTY = "No notes here yet. Write the thing you keep forgetting.";

export type LecturePageProps = {
  lecture: LecturePageData;
  /** The school's LMS name (src/lib/schools.ts). */
  lmsName: string;
  markRead?: (lectureId: string) => Promise<MarkReadResult>;
  remove?: (noteId: string) => Promise<NoteRemoveResult>;
  saveHl?: (lectureId: string, text: string) => Promise<HighlightSaveResult>;
  loadHl?: (lectureId: string) => Promise<HighlightListResult>;
};

const VIEWS: readonly LectureView[] = ["read", "slides", "notes"];

const EXAM_FROM = /^exam:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** `?from=exam:<uuid>` gives that exam page; anything else gives null. */
export function examBackHref(search: string): string | null {
  const from = new URLSearchParams(search).get("from");
  const id = from?.match(EXAM_FROM)?.[1];
  return id ? `/exams/${id.toLowerCase()}` : null;
}

const noSubscribe = () => () => {};

/** Where Back goes when the page was opened from an exam; null on the server and otherwise. */
function useExamBack(): string | null {
  return useSyncExternalStore(
    noSubscribe,
    () => examBackHref(window.location.search),
    () => null,
  );
}

/** An open piece of help in the reader (it marks them `data-lec-help`). */
const OPEN_HELP = "[data-lec-help]";

/**
 * What the main column's scroll would be without the open help.
 * `helps` are the open parts as [top, bottom] in the same coordinates as `viewBottom`.
 * Help above the bottom edge of the view (read past, or on screen) is taken off the scroll
 * position; all of it is taken off the height. Nothing open: the numbers as they are.
 */
export function mainTextScroll(
  scroll: { top: number; height: number; client: number },
  viewBottom: number,
  helps: readonly (readonly [number, number])[],
): { top: number; height: number } {
  let total = 0;
  let passed = 0;
  for (const [top, bottom] of helps) {
    total += Math.max(0, bottom - top);
    passed += Math.max(0, Math.min(bottom, viewBottom) - top);
  }
  return { top: Math.max(0, scroll.top - passed), height: Math.max(scroll.client, scroll.height - total) };
}

/**
 * Gives the ref of an unseen box (with one child) and keeps it scrolled like `main` would be
 * without its open help, so `useReadProgress` can measure the main text only. Follows
 * scrolling, resizing and the reader changing size (help opening or closing).
 */
function useMainTextScroll(main: RefObject<HTMLElement | null>, reader: RefObject<HTMLElement | null>): RefObject<HTMLDivElement | null> {
  const mirror = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = main.current;
    const box = mirror.current;
    const fill = box?.firstElementChild as HTMLElement | null | undefined;
    if (!el || !box || !fill) return;
    let frame: number | null = null;

    const sync = () => {
      frame = null;
      const viewBottom = el.getBoundingClientRect().top + el.clientHeight;
      const helps = Array.from(el.querySelectorAll<HTMLElement>(OPEN_HELP), (h) => {
        const r = h.getBoundingClientRect();
        return [r.top, r.bottom] as const;
      });
      const m = mainTextScroll({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }, viewBottom, helps);
      box.style.height = `${el.clientHeight}px`;
      fill.style.height = `${m.height}px`;
      box.scrollTop = m.top;
      // The height can change with the position staying put; tell the progress hook either way.
      box.dispatchEvent(new Event("scroll"));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(sync);
    };

    sync();
    el.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(el);
    if (reader.current) observer?.observe(reader.current);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [main, reader]);
  return mirror;
}

/** The selected tab of the reader inside `root`. */
function selectedView(root: HTMLElement): LectureView | null {
  const tab = root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  const v = tab?.id.split("-tab-").pop();
  return VIEWS.find((x) => x === v) ?? null;
}

export function LecturePage({
  lecture,
  lmsName,
  markRead = markLectureRead,
  remove = removeNote,
  saveHl = saveHighlight,
  loadHl = lectureHighlights,
}: LecturePageProps) {
  const router = useRouter();
  const mode = useMotionMode();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const main = useRef<HTMLElement | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<LectureView>("read");
  const [read, setRead] = useState(lecture.read);
  // Marked read on this visit (the page's own `lecture.read` turns true too once the action has revalidated).
  const [justRead, setJustRead] = useState(false);
  // Goes up each time a piece of help opens, so its stored highlights are put back.
  const [helpOpened, setHelpOpened] = useState(0);

  // Before the progress hook's effect: the element that scrolls is the app's main column.
  useEffect(() => {
    main.current = document.getElementById("main");
  }, []);
  const mirror = useMainTextScroll(main, readerRef);

  // Follow the reader's tabs, and its help opening.
  useEffect(() => {
    const root = readerRef.current;
    if (!root) return;
    const sync = (records: MutationRecord[] = []) => {
      const v = selectedView(root);
      if (v) setView(v);
      const opened = records.some((r) =>
        Array.from(r.addedNodes).some((node) => node instanceof Element && (node.matches(OPEN_HELP) || node.querySelector(OPEN_HELP))),
      );
      if (opened) setHelpOpened((k) => k + 1);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["aria-selected"], childList: true });
    return () => observer.disconnect();
  }, []);

  const onRead = useCallback(() => {
    void markRead(lecture.lectureId).then(
      (r) => {
        if (r.ok) {
          setRead(true);
          setJustRead(true);
        }
      },
      () => {},
    );
  }, [markRead, lecture.lectureId]);

  const progress = useReadProgress({
    ref: mirror,
    view,
    onRead,
    enabled: !lecture.read && lecture.status === "ready",
  });

  const practise = lecture.practiseHref;
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    const link = (e.target as Element | null)?.closest?.(`a[href="${PRACTISE_ANCHOR}"]`);
    if (!link || !practise) return;
    e.preventDefault();
    router.push(practise);
  };

  const notes = useLectureNotes(lecture.notes, remove);
  const examBack = useExamBack();
  const highlights = useHighlights(lecture.lectureId, saveHl, loadHl);
  // A new list each time help opens: `SelectNote` marks stored highlights again when its list changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `helpOpened` is the reason to make a new list
  const highlightList = useMemo(() => [...highlights.list], [highlights.list, helpOpened]);

  // Opened out of a stop or a row's number: its side of the open (M9-18).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    cardArrival(el);
    return () => leaveCardPage(el);
  }, []);

  const backHref = examBack ?? lecture.backHref;
  /** Back: shrinks into the circle the page was opened from, then the course path's advance can play. */
  const onBack = (e: MouseEvent<HTMLDivElement>) => {
    const link = (e.target as Element | null)?.closest?.("a");
    if (!link || link.getAttribute("href") !== backHref) return;
    closeCardPage(
      e,
      link,
      mode,
      rootRef.current,
      (path) => router.push(path, { scroll: false }),
      backHref,
      LECTURE_PAGE,
      justRead ? { lectureRead: lecture.n } : undefined,
    );
  };

  return (
    <div ref={rootRef} className="mx-auto max-w-[720px] px-[var(--pad)] pb-10" onClickCapture={onBack}>
      <style href="ready-work-transition" precedence="default">
        {WORK_TRANSITION_CSS}
      </style>
      <DoodleDefs />
      <StickyHeader
        padTop="4px"
        className="-mx-[var(--pad)] flex min-h-[52px] items-center gap-1 pr-[var(--pad)] pb-1 pl-[calc(var(--pad)-12px)]"
      >
        <Button
          variant="icon"
          href={backHref}
          aria-label={examBack ? "Back to exam" : `Back to ${lecture.course}`}
        >
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14.5 5.5L8 12l6.5 6.5" />
          </svg>
        </Button>
        <p className="mono min-w-0 truncate text-ink-3">{lecture.course.toUpperCase()}</p>
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden" data-testid="lec-prog">
          <span
            className="block h-full origin-left bg-accent"
            style={{ transform: `scaleX(${progress.toFixed(4)})` }}
          />
        </span>
      </StickyHeader>

      {/* Unseen: the main column's scroll without its open help, for the reading progress. */}
      <div
        ref={mirror}
        aria-hidden="true"
        data-testid="lec-main-text"
        className="pointer-events-none invisible fixed top-0 left-0 w-px overflow-hidden"
      >
        <div />
      </div>

      <div ref={readerRef} className="relative" onClickCapture={onClickCapture}>
        <LectureReader
          course={lecture.course}
          n={lecture.n}
          title={lecture.title}
          lmsName={lmsName}
          status={lecture.status}
          file={lecture.file}
          opensOn={lecture.opensOn}
          minutes={lecture.minutes ?? undefined}
          minutesWithHelp={lecture.minutesWithHelp}
          startHere={lecture.startHere}
          slideCount={lecture.slideCount ?? undefined}
          breath={lecture.breath ?? undefined}
          sections={lecture.sections}
          slideTitles={lecture.slideTitles}
          read={read}
          cards={practise ? lecture.cards : 0}
          practiseHref={practise ? PRACTISE_ANCHOR : undefined}
          next={lecture.next}
          notesCount={notes.list.length}
          notes={<LectureNotes {...notes} />}
        />
        <SelectNote
          containerRef={readerRef}
          active={view === "read" && lecture.status === "ready"}
          highlights={highlightList}
          onAdd={highlights.add}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Highlights

function useHighlights(
  lectureId: string,
  save: (lectureId: string, text: string) => Promise<HighlightSaveResult>,
  load: (lectureId: string) => Promise<HighlightListResult>,
) {
  const [list, setList] = useState<readonly string[]>([]);

  useEffect(() => {
    let live = true;
    void load(lectureId).then(
      (r) => {
        if (live && r.ok && r.texts.length) setList((l) => [...r.texts, ...l.filter((t) => !r.texts.includes(t))]);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [lectureId, load]);

  const add = useCallback(
    (quote: string) => {
      setList((l) => (l.includes(quote) ? l : [...l, quote]));
      void save(lectureId, quote).catch(() => {});
      openNotepad({ quote });
    },
    [lectureId, save],
  );

  return { list, add };
}

// ---------------------------------------------------------------------------
// Notes

function useLectureNotes(initial: NoteCardData[], remove: (id: string) => Promise<NoteRemoveResult>) {
  const mode = useMotionMode();
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [edits, setEdits] = useState<Readonly<Record<string, NoteSavedDetail>>>({});
  const [popId, setPopId] = useState<string | null>(null);

  useEffect(() => {
    const onSaved = (e: Event) => {
      const d = (e as CustomEvent<NoteSavedDetail>).detail;
      if (!d?.id) return;
      setEdits((m) => ({ ...m, [d.id]: d }));
      if (d.created) setPopId(d.id);
    };
    window.addEventListener(NOTE_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(NOTE_SAVED_EVENT, onSaved);
  }, []);

  const list = useMemo(
    () =>
      initial
        .filter((n) => !gone.has(n.id))
        .map((n) => {
          const e = edits[n.id];
          return e ? { ...n, title: e.title, body: e.body, quote: e.quote, highlighted: e.highlighted } : n;
        }),
    [initial, gone, edits],
  );

  const open = (n: NoteCardData) => {
    setPopId(null);
    openNotepad({
      note: { id: n.id, title: n.title ?? "", body: n.body, quote: n.quote, highlighted: n.highlighted, label: n.attachLabel },
    });
  };

  const del = async (n: NoteCardData) => {
    const r = await remove(n.id);
    if (r.ok || r.reason === "not_found") setGone((s) => new Set(s).add(n.id));
  };

  return { list, open, del, popId: mode === "full" ? popId : null };
}

function LectureNotes({
  list,
  open,
  del,
  popId,
}: {
  list: NoteCardData[];
  open: (n: NoteCardData) => void;
  del: (n: NoteCardData) => Promise<void>;
  popId: string | null;
}) {
  return (
    <div className="grid justify-items-start gap-4">
      {list.length > 0 ? (
        <div className="@container w-full">
          <div className="columns-1 gap-x-3.5 @min-[620px]:columns-2">
            {list.map((n) => (
              <NoteCard key={n.id} note={n} onOpen={open} onDelete={del} pop={n.id === popId} />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 py-3 text-[13px] text-ink-3">
          <DoodlePencil size={56} className="flex-none" />
          <p>{NOTES_EMPTY}</p>
        </div>
      )}
      <Button variant="secondary" onClick={() => openNotepad()}>
        New note
      </Button>
    </div>
  );
}

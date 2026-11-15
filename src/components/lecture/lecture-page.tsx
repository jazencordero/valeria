"use client";

/**
 * One lecture's page (M9-15): sticky header, the reader, its notes, reading
 * progress and marking it read, and "Practise this lecture".
 * Source: prototype merged-2.html JS 5497-5560 (lecturePageHTML,
 * renderLecNotes, setLecMode, lecProgress) and CSS 1039-1041 (.lec-head,
 * .lec-prog).
 *
 * - Header: "Back to <course>" (the course page), the course name in mono
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
 * Plain data in. `markRead` and `remove` default to the real actions; a
 * preview can pass stand-ins.
 *
 * Cut: the grow-out-of-the-stop transition (M9-18), the path's advance on
 * Back (the course page does not take it yet), "Ask about this lecture"
 * (M9-22) and text selection to a note.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { markLectureRead, type MarkReadResult } from "@/app/(app)/courses/[id]/lectures/[n]/actions";
import { removeNote, type NoteRemoveResult } from "@/app/(app)/notes/actions";
import { DoodleDefs } from "@/components/doodle";
import { DoodlePencil } from "@/components/doodle-pencil";
import { LectureReader, type LectureView } from "@/components/lecture/reader";
import { useReadProgress } from "@/components/lecture/use-read-progress";
import { NoteCard, type NoteCardData } from "@/components/notes/note-card";
import { NOTE_SAVED_EVENT, openNotepad, type NoteSavedDetail } from "@/components/notes/notepad";
import { Button } from "@/components/ui/button";
import { StickyHeader } from "@/components/ui/sticky-header";
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
};

const VIEWS: readonly LectureView[] = ["read", "slides", "notes"];

/** The selected tab of the reader inside `root`. */
function selectedView(root: HTMLElement): LectureView | null {
  const tab = root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  const v = tab?.id.split("-tab-").pop();
  return VIEWS.find((x) => x === v) ?? null;
}

export function LecturePage({ lecture, lmsName, markRead = markLectureRead, remove = removeNote }: LecturePageProps) {
  const router = useRouter();
  const main = useRef<HTMLElement | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<LectureView>("read");
  const [read, setRead] = useState(lecture.read);

  // Before the progress hook's effect: the element that scrolls is the app's main column.
  useEffect(() => {
    main.current = document.getElementById("main");
  }, []);

  // Follow the reader's tabs.
  useEffect(() => {
    const root = readerRef.current;
    if (!root) return;
    const sync = () => {
      const v = selectedView(root);
      if (v) setView(v);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["aria-selected"], childList: true });
    return () => observer.disconnect();
  }, []);

  const onRead = useCallback(() => {
    void markRead(lecture.lectureId).then(
      (r) => {
        if (r.ok) setRead(true);
      },
      () => {},
    );
  }, [markRead, lecture.lectureId]);

  const progress = useReadProgress({
    ref: main,
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

  return (
    <div className="mx-auto max-w-[720px] px-[var(--pad)] pb-10">
      <DoodleDefs />
      <StickyHeader
        padTop="4px"
        className="-mx-[var(--pad)] flex min-h-[52px] items-center gap-1 pr-[var(--pad)] pb-1 pl-[calc(var(--pad)-12px)]"
      >
        <Button variant="icon" href={lecture.backHref} aria-label={`Back to ${lecture.course}`}>
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

      <div ref={readerRef} onClickCapture={onClickCapture}>
        <LectureReader
          course={lecture.course}
          n={lecture.n}
          title={lecture.title}
          lmsName={lmsName}
          status={lecture.status}
          file={lecture.file}
          opensOn={lecture.opensOn}
          minutes={lecture.minutes ?? undefined}
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
      </div>
    </div>
  );
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

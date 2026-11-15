"use client";

/**
 * Notes tab body (ticket M9-14): search, "New note", the course filter and
 * the masonry grid of note cards.
 * Source: prototype merged.html HTML 1883-1886 (.notes-tools, #notes-filters,
 * .notes-grid, #notes-empty), CSS 1092-1096 and JS 5696-5721 (buildNoteFilters,
 * renderNotes, setNoteFilter).
 *
 * Search and the course filter live in the URL (`?q=` and `?course=`, a
 * course id or `general`), so a filtered view can be shared and the server
 * filters with `listNotes`. Typing replaces the URL 250 ms after the last key;
 * a chip replaces it at once and moves before the list arrives. Both combine.
 *
 * The grid is columns in a container query: 1, 2 from 620 px, 3 from 940 px
 * of its own width.
 *
 * Live updates from the notepad (`NOTE_SAVED_EVENT`): a note created here
 * shows up when the action's `refresh()` brings it, and springs in; an edited
 * note's card follows her words without a reload. Delete hides the card at
 * once; the action's `refresh()` brings the sidebar count along.
 *
 * Plain data in. `remove` defaults to the real action; the dev page passes a
 * stand-in.
 */
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import { removeNote, type NoteRemoveResult } from "@/app/(app)/notes/actions";
import { DoodlePencil } from "@/components/doodle-pencil";
import { NoteCard, type NoteCardData } from "@/components/notes/note-card";
import { NOTE_SAVED_EVENT, openNotepad, type NoteSavedDetail } from "@/components/notes/notepad";
import { Button } from "@/components/ui/button";
import { Chip, ChipRow } from "@/components/ui/chip";
import { useMotionMode } from "@/lib/motion/use-calm";

export const GENERAL_FILTER = "general";
export const SEARCH_PAUSE_MS = 250;

export type NotesGridProps = {
  notes: NoteCardData[];
  /** Her visible courses, short names, for the chips. */
  courses: { id: string; name: string }[];
  /** The search in the URL. */
  query: string;
  /** The chosen course id, "general", or null for All. */
  course: string | null;
  remove?: (id: string) => Promise<NoteRemoveResult>;
};

function urlOf(pathname: string, q: string, course: string | null): string {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (course) params.set("course", course);
  const s = params.toString();
  return s ? `${pathname}?${s}` : pathname;
}

export function NotesGrid({ notes, courses, query, course, remove = removeNote }: NotesGridProps) {
  const router = useRouter();
  const pathname = usePathname();
  const mode = useMotionMode();
  const searchId = useId();
  const [, startTransition] = useTransition();
  const [shownCourse, setShownCourse] = useOptimistic(course);
  const [q, setQ] = useState(query);
  const qRef = useRef(q);
  const pause = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Cards she deleted here; hidden before the refresh lands. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  /** Her latest words per note, from the notepad. */
  const [edits, setEdits] = useState<Readonly<Record<string, NoteSavedDetail>>>({});
  /** The note just created here, to spring in when it arrives. */
  const [popId, setPopId] = useState<string | null>(null);

  useEffect(() => () => clearTimeout(pause.current), []);

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

  const go = (nextQ: string, nextCourse: string | null) => {
    startTransition(() => {
      setShownCourse(nextCourse);
      router.replace(urlOf(pathname ?? "/notes", nextQ, nextCourse), { scroll: false });
    });
  };

  const type = (value: string) => {
    setQ(value);
    qRef.current = value;
    clearTimeout(pause.current);
    pause.current = setTimeout(() => go(qRef.current, shownCourse), SEARCH_PAUSE_MS);
  };

  const choose = (next: string | null) => {
    if (next === shownCourse) return;
    clearTimeout(pause.current);
    go(qRef.current, next);
  };

  const list = useMemo(
    () =>
      notes
        .filter((n) => !gone.has(n.id))
        .map((n) => {
          const e = edits[n.id];
          if (!e) return n;
          return { ...n, title: e.title, body: e.body, quote: e.quote, highlighted: e.highlighted };
        }),
    [notes, gone, edits],
  );

  const open = (n: NoteCardData) => {
    setPopId(null);
    openNotepad({
      note: {
        id: n.id,
        title: n.title ?? "",
        body: n.body,
        quote: n.quote,
        highlighted: n.highlighted,
        label: n.attachLabel,
      },
    });
  };

  const del = async (n: NoteCardData) => {
    const r = await remove(n.id);
    if (r.ok || r.reason === "not_found") setGone((s) => new Set(s).add(n.id));
  };

  return (
    <>
      <div className="mt-[18px] flex items-center gap-2">
        <label className="sr-only" htmlFor={searchId}>
          Search notes
        </label>
        <input
          id={searchId}
          type="search"
          placeholder="Search notes"
          autoComplete="off"
          value={q}
          onChange={(e) => type(e.target.value)}
          className={
            "h-12 min-w-0 flex-1 rounded-[16px] border border-line bg-paper px-4 text-[16px] text-ink " +
            "placeholder:text-ink-3 focus-visible:border-ink-3 focus-visible:outline-none"
          }
        />
        <Button size="sm" onClick={() => openNotepad()}>
          New note
        </Button>
      </div>

      <ChipRow bleed={20} role="group" aria-label="Filter notes by course" className="mt-3 mb-2">
        <Chip pressed={shownCourse === null} onClick={() => choose(null)}>
          All
        </Chip>
        {courses.map((c) => (
          <Chip key={c.id} pressed={shownCourse === c.id} onClick={() => choose(c.id)}>
            {c.name}
          </Chip>
        ))}
        <Chip pressed={shownCourse === GENERAL_FILTER} onClick={() => choose(GENERAL_FILTER)}>
          General
        </Chip>
      </ChipRow>

      {list.length > 0 ? (
        <div className="@container mt-2">
          <div className="columns-1 gap-x-3.5 @min-[620px]:columns-2 @min-[940px]:columns-3">
            {list.map((n) => (
              <NoteCard
                key={n.id}
                note={n}
                onOpen={open}
                onDelete={del}
                pop={mode === "full" && n.id === popId}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 py-3 text-[13px] text-ink-3">
          <DoodlePencil size={56} className="flex-none" />
          <p>No notes here yet. Write the thing you keep forgetting.</p>
        </div>
      )}
    </>
  );
}

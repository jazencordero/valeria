"use client";

/**
 * Exam page, Notes tab (M9-23).
 * Source: prototype merged-2.html JS 6081-6096 (notesTabHTML,
 * renderExamNotes) and CSS 1483-1492, 1504 (.xn-top, .xn-grid: two columns
 * from 700 px).
 *
 * "Your notes for <course>, from lectures and this exam." and "New note",
 * which opens the notepad on this page, so the note is attached to this exam
 * (`attachFromPath` reads `/exams/<id>`). Then her note cards (M9-14's
 * `NoteCard`, whose menu holds "Turn into cards" and Delete), or the empty
 * state. Then the exam's documents (M3-54), when it has any.
 *
 * A note made here arrives with the notepad's refresh (the server reads the
 * notes again); an edit shows at once (`NOTE_SAVED_EVENT`) and pops in when
 * it is new; a delete hides the card at once. `useExamNotes` holds that list
 * so the page can show its count on the tab.
 *
 * Plain data in; `remove` defaults to the real action.
 */
import { useEffect, useMemo, useState } from "react";
import { removeNote, type NoteRemoveResult } from "@/app/(app)/notes/actions";
import { DoodlePencil } from "@/components/doodle-pencil";
import { ExamDocuments, type ExamDocumentRow } from "@/components/exams/exam-documents";
import { NoteCard, type NoteCardData } from "@/components/notes/note-card";
import { NOTE_SAVED_EVENT, openNotepad, type NoteSavedDetail } from "@/components/notes/notepad";
import { Button } from "@/components/ui/button";
import { useMotionMode } from "@/lib/motion/use-calm";

export const EXAM_NOTES_EMPTY = "No notes here yet. Write the thing you keep forgetting.";

export const examNotesLine = (course: string, kind: "exam" | "quiz") =>
  `Your notes for ${course}, from lectures and this ${kind}.`;

export type ExamNotesState = {
  list: NoteCardData[];
  open: (n: NoteCardData) => void;
  del: (n: NoteCardData) => Promise<void>;
  popId: string | null;
};

export function useExamNotes(
  initial: readonly NoteCardData[],
  remove: (id: string) => Promise<NoteRemoveResult> = removeNote,
): ExamNotesState {
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

export type ExamNotesTabProps = {
  examId: string;
  course: string;
  kind: "exam" | "quiz";
  notes: ExamNotesState;
  documents?: readonly ExamDocumentRow[];
};

export function ExamNotesTab({ examId, course, kind, notes, documents = [] }: ExamNotesTabProps) {
  const { list, open, del, popId } = notes;
  return (
    <div className="grid gap-4" data-testid="exam-notes">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-ink-2">{examNotesLine(course, kind)}</p>
        <Button variant="secondary" size="sm" className="flex-none whitespace-nowrap" onClick={() => openNotepad()}>
          New note
        </Button>
      </div>
      {list.length > 0 ? (
        <div className="columns-1 gap-x-3.5 min-[700px]:columns-2">
          {list.map((n) => (
            <NoteCard key={n.id} note={n} onOpen={open} onDelete={del} pop={n.id === popId} />
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-3 py-3 text-[13px] text-ink-3">
          <DoodlePencil size={56} className="flex-none" />
          <p>{EXAM_NOTES_EMPTY}</p>
        </div>
      )}
      <ExamDocuments examId={examId} documents={documents} />
    </div>
  );
}

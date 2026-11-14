"use client";

/**
 * Preview of the exam form (M3-13). Sample courses and a fake submit that
 * shows what the form posted; nothing is saved. "Server says no" makes the
 * fake answer like the server does when a course is not hers.
 */
import { useState } from "react";
import {
  ExamForm,
  type ExamFormAction,
  type ExamFormValues,
  type ExamRemoveAction,
} from "@/components/exams/exam-form";
import { Button } from "@/components/ui/button";

const COURSES = [
  { id: "7d1c2f0a-1b2c-4d3e-8f40-5a6b7c8d9e01", name: "Linear algebra" },
  { id: "7d1c2f0a-1b2c-4d3e-8f40-5a6b7c8d9e02", name: "Organic chemistry" },
  { id: "7d1c2f0a-1b2c-4d3e-8f40-5a6b7c8d9e03", name: "History of design" },
];

const EXISTING: ExamFormValues & { id: string } = {
  id: "3a9e0c1d-2b3c-4d5e-8f60-7a8b9c0d1e02",
  courseId: COURSES[1].id,
  title: "Midterm",
  kind: "quiz",
  date: "2026-12-03",
  time: "14:15",
  targetGrade: 3,
};

type Demo = "add" | "edit" | "refused" | null;

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function ExamFormPage() {
  const [open, setOpen] = useState<Demo>(null);
  const [posted, setPosted] = useState<Record<string, string> | null>(null);
  const [log, setLog] = useState("");
  const refused = open === "refused";

  const fakeSave: ExamFormAction = async (_prev, formData) => {
    const fields: Record<string, string> = {};
    formData.forEach((v, k) => {
      if (typeof v === "string") fields[k] = v;
    });
    await wait(400);
    if (refused) {
      return { status: "error", errors: {}, message: "That exam or course is not in your list any more." };
    }
    setPosted(fields);
    return { status: "saved", examId: fields.examId ?? "new-exam-id" };
  };

  const fakeRemove: ExamRemoveAction = async (examId) => {
    await wait(400);
    setLog(`Removed ${examId}`);
    return { ok: true };
  };

  return (
    <main className="mx-auto max-w-4xl space-y-10 px-5 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Exam form</h1>
        <p className="ink-2">
          Add an exam or quiz, or correct one. Times are Helsinki time. Nothing
          is saved here: the fake submit shows what the form posted.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setTheme("light")}>
            Light
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setTheme("dark")}>
            Dark
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setTheme("system")}>
            System
          </Button>
        </div>
      </header>

      <section className="space-y-3">
        <h2 className="type-h22">States</h2>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setOpen("add")} data-testid="open-add">
            Add an exam
          </Button>
          <Button onClick={() => setOpen("edit")} data-testid="open-edit">
            Edit an exam
          </Button>
          <Button onClick={() => setOpen("refused")} data-testid="open-refused">
            Server says no
          </Button>
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="posted-title">
        <h2 id="posted-title" className="type-h22">
          Last submit
        </h2>
        <pre data-testid="posted" aria-live="polite" className="font-mono text-sm whitespace-pre-wrap">
          {posted ? JSON.stringify(posted, null, 2) : "Nothing yet."}
        </pre>
        <p className="fine" data-testid="log">
          {log}
        </p>
      </section>

      <ExamForm
        open={open !== null}
        onClose={() => setOpen(null)}
        courses={COURSES}
        exam={open === "edit" ? EXISTING : undefined}
        defaults={open === "refused" ? { courseId: COURSES[0].id, title: "Final", date: "2027-01-12" } : undefined}
        action={fakeSave}
        onSaved={() => setOpen(null)}
        removeAction={fakeRemove}
        onRemoved={() => setOpen(null)}
      />
    </main>
  );
}

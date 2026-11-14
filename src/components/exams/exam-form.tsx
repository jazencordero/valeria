"use client";

/**
 * Exam form (M3-13): add an exam or quiz, or correct one, in a Sheet.
 * Provisional look until M8-01 designs it (not in the prototype).
 *
 * Fields: course, name, exam or quiz, date, time (Helsinki wall-clock time,
 * as typed), target grade 1 to 5. Every field has a visible label; the two
 * choices are radio groups in a fieldset, so arrow keys move between them.
 *
 * The form does no time-zone maths and no fetching. It posts its fields
 * (plus `examId` when editing) to `action`, a `useActionState` action: the
 * real one is `saveExamAction` from src/app/(app)/exams/actions.ts, passed in
 * by a server page; /dev/exam-form passes a fake. Missing fields are caught
 * here before posting; the server checks everything again.
 *
 * Errors: each field gets `aria-invalid` and its message through
 * `aria-describedby`; a summary is announced in a `role="alert"` line, and
 * focus moves to the first field with a problem.
 */
import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import type { ExamField, ExamFieldErrors } from "@/server/study/exams";

export type ExamFormCourse = { id: string; name: string };

/** An exam as the form edits it: date and time are Helsinki strings (see `instantToHelsinki`). */
export type ExamFormValues = {
  courseId: string;
  title: string;
  kind: "exam" | "quiz";
  date: string;
  time: string;
  targetGrade: 1 | 2 | 3 | 4 | 5;
};

export type ExamFormState =
  | { status: "idle" }
  | { status: "error"; errors: ExamFieldErrors; message?: string }
  | { status: "saved"; examId: string };

export type ExamFormAction = (prev: ExamFormState, formData: FormData) => Promise<ExamFormState>;
export type ExamRemoveAction = (examId: string) => Promise<{ ok: true } | { ok: false; message: string }>;

export type ExamFormProps = {
  open: boolean;
  onClose: () => void;
  /** Her courses, for the picker. */
  courses: ExamFormCourse[];
  /** The exam being corrected; leave out to add a new one. */
  exam?: ExamFormValues & { id: string };
  /** Values for a new exam, e.g. the course she opened it from. */
  defaults?: Partial<ExamFormValues>;
  action: ExamFormAction;
  /** Called once the action reports the exam saved. */
  onSaved?: (examId: string) => void;
  /** Shows "Remove" when editing. */
  removeAction?: ExamRemoveAction;
  onRemoved?: () => void;
};

const GRADES = [1, 2, 3, 4, 5] as const;
const TITLE_MAX = 120;
const ORDER: ExamField[] = ["courseId", "title", "kind", "date", "time", "targetGrade"];

const INPUT =
  "min-h-11 w-full rounded-xl border border-solid border-line bg-surface px-3 text-[16px] text-ink " +
  "aria-invalid:border-ink";
const LABEL = "mb-1.5 block text-[14px] font-medium text-ink";
const PILL =
  "relative inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full border border-solid " +
  "border-line bg-surface px-4 text-[15px] text-ink-2 " +
  "has-[:checked]:border-ink has-[:checked]:bg-paper has-[:checked]:font-medium has-[:checked]:text-ink " +
  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink";

/** Client-side check for what is simply missing; the server does the full check. */
function missing(v: ExamFormValues): ExamFieldErrors {
  const e: ExamFieldErrors = {};
  if (!v.courseId) e.courseId = "Pick a course.";
  if (!v.title.trim()) e.title = "Give it a name.";
  if (!v.date) e.date = "Pick a date.";
  if (!v.time) e.time = "Pick a time.";
  return e;
}

function summary(errors: ExamFieldErrors): string {
  const n = Object.keys(errors).length;
  if (n === 0) return "";
  return n === 1 ? "One thing to fix before saving." : `${n} things to fix before saving.`;
}

function FieldError({ id, children }: { id: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} className="mt-1.5 text-[14px] text-ink">
      {children}
    </p>
  );
}

export function ExamForm(props: ExamFormProps) {
  const { open, onClose, exam } = props;
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      locked={busy}
      title={exam ? "Edit exam" : "Add an exam"}
      data-testid="exam-form"
    >
      <ExamFormBody {...props} onBusy={setBusy} />
    </Sheet>
  );
}

function ExamFormBody({
  onClose,
  courses,
  exam,
  defaults,
  action,
  onSaved,
  removeAction,
  onRemoved,
  onBusy,
}: ExamFormProps & { onBusy: (busy: boolean) => void }) {
  const uid = useId();
  const ids = Object.fromEntries(ORDER.map((f) => [f, `${uid}-${f}`])) as Record<ExamField, string>;
  const errId = (f: ExamField) => `${ids[f]}-error`;

  const [values, setValues] = useState<ExamFormValues>(() => ({
    courseId: exam?.courseId ?? defaults?.courseId ?? (courses.length === 1 ? courses[0].id : ""),
    title: exam?.title ?? defaults?.title ?? "",
    kind: exam?.kind ?? defaults?.kind ?? "exam",
    date: exam?.date ?? defaults?.date ?? "",
    time: exam?.time ?? defaults?.time ?? "09:00",
    targetGrade: exam?.targetGrade ?? defaults?.targetGrade ?? 4,
  }));
  const set = <K extends keyof ExamFormValues>(key: K, value: ExamFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const [state, formAction, pending] = useActionState<ExamFormState, FormData>(async (prev, formData) => {
    const errors = missing(values);
    if (Object.keys(errors).length > 0) return { status: "error", errors };
    return action(prev, formData);
  }, { status: "idle" });

  const [removing, setRemoving] = useState<"idle" | "confirm" | "busy">("idle");
  const [removeError, setRemoveError] = useState("");
  const busy = pending || removing === "busy";
  useEffect(() => onBusy(busy), [busy, onBusy]);

  const formRef = useRef<HTMLFormElement>(null);
  const errors: ExamFieldErrors = state.status === "error" ? state.errors : {};
  const message = state.status === "error" ? (state.message ?? summary(errors)) : "";

  // After a failed save, focus the first field with a problem.
  useEffect(() => {
    if (state.status !== "error") return;
    const first = ORDER.find((f) => state.errors[f]);
    if (!first) return;
    const el = formRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`);
    el?.focus();
  }, [state]);

  useEffect(() => {
    if (state.status === "saved") onSaved?.(state.examId);
    // onSaved is the caller's; fire once per saved state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const invalid = (f: ExamField) =>
    errors[f] ? { "aria-invalid": true as const, "aria-describedby": errId(f) } : {};

  async function remove() {
    if (!exam || !removeAction) return;
    if (removing === "idle") {
      setRemoving("confirm");
      return;
    }
    setRemoving("busy");
    setRemoveError("");
    const result = await removeAction(exam.id);
    if (result.ok) {
      setRemoving("idle");
      onRemoved?.();
    } else {
      setRemoving("confirm");
      setRemoveError(result.message);
    }
  }

  return (
    <form ref={formRef} action={formAction} noValidate className="mt-3 space-y-5">
      {exam ? <input type="hidden" name="examId" value={exam.id} /> : null}

      <p role="alert" className="text-[14px] text-ink empty:hidden">
        {message}
      </p>

      <div>
        <label htmlFor={ids.courseId} className={LABEL}>
          Course
        </label>
        <select
          id={ids.courseId}
          name="courseId"
          data-field="courseId"
          value={values.courseId}
          onChange={(e) => set("courseId", e.target.value)}
          required
          className={INPUT}
          {...invalid("courseId")}
        >
          <option value="" disabled>
            Pick a course
          </option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <FieldError id={errId("courseId")}>{errors.courseId}</FieldError>
      </div>

      <div>
        <label htmlFor={ids.title} className={LABEL}>
          Name
        </label>
        <input
          id={ids.title}
          name="title"
          data-field="title"
          type="text"
          value={values.title}
          onChange={(e) => set("title", e.target.value)}
          maxLength={TITLE_MAX}
          required
          autoComplete="off"
          placeholder="Final exam"
          className={INPUT}
          {...invalid("title")}
        />
        <FieldError id={errId("title")}>{errors.title}</FieldError>
      </div>

      <fieldset {...(errors.kind ? { "aria-describedby": errId("kind") } : {})}>
        <legend className={LABEL}>Exam or quiz</legend>
        <div className="flex gap-2">
          {(["exam", "quiz"] as const).map((k, i) => (
            <label key={k} className={PILL}>
              <input
                type="radio"
                name="kind"
                value={k}
                data-field={i === 0 ? "kind" : undefined}
                checked={values.kind === k}
                onChange={() => set("kind", k)}
                className="sr-only"
              />
              {k === "exam" ? "Exam" : "Quiz"}
            </label>
          ))}
        </div>
        <FieldError id={errId("kind")}>{errors.kind}</FieldError>
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={ids.date} className={LABEL}>
            Date
          </label>
          <input
            id={ids.date}
            name="date"
            data-field="date"
            type="date"
            value={values.date}
            onChange={(e) => set("date", e.target.value)}
            required
            className={INPUT}
            {...invalid("date")}
          />
          <FieldError id={errId("date")}>{errors.date}</FieldError>
        </div>
        <div>
          <label htmlFor={ids.time} className={LABEL}>
            Time
          </label>
          <input
            id={ids.time}
            name="time"
            data-field="time"
            type="time"
            value={values.time}
            onChange={(e) => set("time", e.target.value)}
            required
            className={INPUT}
            aria-describedby={errors.time ? errId("time") : `${ids.time}-hint`}
            aria-invalid={errors.time ? true : undefined}
          />
          {errors.time ? (
            <FieldError id={errId("time")}>{errors.time}</FieldError>
          ) : (
            <p id={`${ids.time}-hint`} className="mt-1.5 text-[13px] text-ink-3">
              Helsinki time
            </p>
          )}
        </div>
      </div>

      <fieldset {...(errors.targetGrade ? { "aria-describedby": errId("targetGrade") } : {})}>
        <legend className={LABEL}>Target grade</legend>
        <div className="flex gap-2">
          {GRADES.map((g, i) => (
            <label key={g} className={PILL + " min-w-11 px-0"}>
              <input
                type="radio"
                name="targetGrade"
                value={g}
                data-field={i === 0 ? "targetGrade" : undefined}
                checked={values.targetGrade === g}
                onChange={() => set("targetGrade", g)}
                className="sr-only"
              />
              {g}
            </label>
          ))}
        </div>
        <FieldError id={errId("targetGrade")}>{errors.targetGrade}</FieldError>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="submit" loading={pending} loadingLabel="Saving">
          {exam ? "Save" : "Add exam"}
        </Button>
        <Button variant="text" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {exam && removeAction ? (
          <Button
            variant="text"
            className="ml-auto"
            onClick={remove}
            loading={removing === "busy"}
            disabled={pending}
          >
            {removing === "idle" ? "Remove" : "Yes, remove it"}
          </Button>
        ) : null}
      </div>
      <p aria-live="polite" className="text-[14px] text-ink empty:hidden">
        {removing === "confirm" && !removeError ? "Press again to remove this exam and its cards." : removeError}
      </p>
    </form>
  );
}

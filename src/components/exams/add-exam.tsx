"use client";

/**
 * "Add an exam" on the Exams tab (M3-41): the button and the form sheet it
 * opens (M3-13's `ExamForm`).
 *
 * The form is a client sheet that wants `open` and `onClose`, and the Exams
 * page is a Server Component, so this small wrapper holds the open state.
 * The page passes her courses and `saveExamAction`; saving revalidates
 * /exams there, so the new card is in the list when the sheet has closed.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ExamForm, type ExamFormAction, type ExamFormCourse } from "./exam-form";

export type AddExamProps = {
  /** Her courses, for the form's picker. */
  courses: ExamFormCourse[];
  /** `saveExamAction` from src/app/(app)/exams/actions.ts. */
  action: ExamFormAction;
};

export function AddExam({ courses, action }: AddExamProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Add an exam
      </Button>
      <ExamForm open={open} onClose={close} courses={courses} action={action} onSaved={close} />
    </>
  );
}

"use client";
/*
 * Mock exams (M3-60): Retake / Start / Resume. Retake asks first (the scores stay, a new attempt
 * starts with question 1 reshuffled); Start and Resume go straight in. The server action starts
 * the attempt (or finds the open one) and redirects to its first question.
 */
import { useState, useTransition } from "react";
import { startMockExamAction } from "@/app/(app)/exams/mock/actions";
import { Button } from "@/components/ui/button";

export function RetakeButton({ examId }: { examId: string }) {
  const [asking, setAsking] = useState(false);
  const [busy, start] = useTransition();
  if (!asking) {
    return (
      <Button variant="secondary" onClick={() => setAsking(true)}>
        Retake
      </Button>
    );
  }
  return (
    <div className="rounded-2xl border border-line bg-surface p-3 min-[480px]:col-span-3" role="group" aria-label="Retake?">
      <p className="text-[15px]">A new attempt, with question 1 reshuffled. Every score you have stays.</p>
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={() => setAsking(false)}>
          Keep
        </Button>
        <Button size="sm" loading={busy} loadingLabel="Starting" onClick={() => start(() => startMockExamAction(examId))}>
          Retake
        </Button>
      </div>
    </div>
  );
}

export function StartButton({ examId, label }: { examId: string; label: string }) {
  const [busy, start] = useTransition();
  return (
    <Button size="lg" block loading={busy} loadingLabel="Opening" onClick={() => start(() => startMockExamAction(examId))}>
      {label}
    </Button>
  );
}

"use client";

/**
 * AI policy: does this course allow AI help on homework? (M2-21)
 *
 * Aalto sets AI rules per course and we do not read syllabi, so she tells us.
 * While the course's `ai_policy` is "unknown", the assignment page shows a
 * small card before the chat with "Yes", "No" and "Not sure":
 *
 *   Yes      -> "allowed"      (unlocks drafting, cards and lecture pages)
 *   No       -> "not_allowed"
 *   Not sure -> stays "unknown"
 *
 * The schema has no "answered" flag, so "Not sure" keeps "unknown" in the
 * database and the card is hidden for the rest of this view only; it asks
 * again on her next visit. That is on purpose: unknown is the safe state.
 *
 * For "not_allowed" and "unknown" the chat is explain-only and a visible line
 * says so, with a link to change the answer. "allowed" shows nothing.
 *
 * Plain data in, one callback out: the page passes
 * `setPolicy={setCourseAiPolicy.bind(null, course.id)}` from
 * `src/app/(app)/assignments/[id]/policy-actions.ts`.
 */
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AiPolicy, PolicyResult } from "@/app/(app)/assignments/[id]/policy-actions";

export type { AiPolicy };
export type PolicyAnswer = "yes" | "no" | "not_sure";

export const EXPLAIN_ONLY_LINE = "Explain-only: this course does not allow AI-written homework.";

/** What each button stores in `courses.ai_policy`. */
export const ANSWER_POLICY: Record<PolicyAnswer, AiPolicy> = {
  yes: "allowed",
  no: "not_allowed",
  not_sure: "unknown",
};

/**
 * True unless she said the course allows AI help. Explain-only means: no
 * AI-written homework, and none of the course's file text goes to a hosted AI.
 */
export function isExplainOnly(policy: AiPolicy): boolean {
  return policy !== "allowed";
}

export type AiPolicyCardProps = {
  courseName: string;
  /** The course's `ai_policy` as the server read it. */
  policy: AiPolicy;
  /** Stores the new value. Usually the bound server action. */
  setPolicy: (policy: AiPolicy) => Promise<PolicyResult>;
  className?: string;
};

const BUTTONS: { answer: PolicyAnswer; label: string }[] = [
  { answer: "yes", label: "Yes" },
  { answer: "no", label: "No" },
  { answer: "not_sure", label: "Not sure" },
];

export function AiPolicyCard({ courseName, policy: initial, setPolicy, className = "" }: AiPolicyCardProps) {
  const questionId = useId();
  const [policy, setLocalPolicy] = useState<AiPolicy>(initial);
  // Answered in this view (covers "Not sure", which leaves "unknown").
  const [answered, setAnswered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<PolicyAnswer | null>(null);
  const [failed, setFailed] = useState(false);

  // A new value from the server (after refresh) wins over the local copy.
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    setLocalPolicy(initial);
  }

  const asking = editing || (policy === "unknown" && !answered);
  const explainOnly = isExplainOnly(policy);

  async function answer(choice: PolicyAnswer) {
    if (pending) return;
    setPending(choice);
    setFailed(false);
    try {
      const result = await setPolicy(ANSWER_POLICY[choice]);
      if (result.ok) {
        setLocalPolicy(result.policy);
        setAnswered(true);
        setEditing(false);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  }

  if (!asking && !explainOnly) return null;

  return (
    <div className={`flex flex-col gap-2.5 ${className}`} data-testid="ai-policy">
      {asking && (
        <section
          aria-labelledby={questionId}
          className="rounded-[14px] border border-solid border-line bg-surface p-4"
        >
          <p id={questionId} className="text-[15px] leading-[1.45] text-ink">
            Does {courseName} allow AI help on homework?{" "}
            <span className="text-ink-2">Check the syllabus.</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {BUTTONS.map(({ answer: choice, label }) => (
              <Button
                key={choice}
                variant="secondary"
                size="sm"
                loading={pending === choice}
                disabled={pending !== null && pending !== choice}
                onClick={() => answer(choice)}
              >
                {label}
              </Button>
            ))}
          </div>
          {failed && (
            <p role="alert" className="mt-2.5 text-[14px] text-ink">
              Could not save that. Try again.
            </p>
          )}
        </section>
      )}
      {explainOnly && (
        <p className="text-[14px] leading-[1.45] text-ink-2" data-testid="ai-policy-explain-only">
          {EXPLAIN_ONLY_LINE}
          {!asking && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => {
                  setFailed(false);
                  setEditing(true);
                }}
                className="font-medium text-ink underline decoration-ink-3 underline-offset-2 hover:decoration-ink"
              >
                Change answer
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

"use client";

/**
 * AI policy: does this course allow AI help on homework? (M2-21, M2-27)
 *
 * Aalto sets AI rules per course and we do not read syllabi, so she tells us.
 * While the course's `ai_assignments` is "unknown", the assignment page shows
 * a small card where the chat would be:
 *
 *   Yes              -> "allowed"   (the chat reads the brief and may draft with her)
 *   Only to explain  -> "explain"   (the chat explains; no course text, no drafts)
 *   No               -> "off"       (no chat at all)
 *   Not sure         -> stays "unknown", which is off
 *
 * The schema has no "answered" flag, so "Not sure" keeps "unknown" in the
 * database and the card is hidden for the rest of this view only; it asks
 * again on her next visit. That is on purpose: unknown is the safe state.
 *
 * What shows under the card (`policyLine`):
 *   "unknown"   the page shows no chat (`chatHidden`), only AI_UNKNOWN_LINE: we do
 *               not know the rule, so it never says the course forbids AI. The
 *               question card sits above it until she answers.
 *   "off"       no chat, AI_OFF_LINE (only an answered "No" says the course does
 *               not allow AI help) and the link to change the answer.
 *   "explain"   the chat is there, with EXPLAIN_ONLY_LINE and the link.
 *   "allowed"   nothing.
 *
 * Study material (cards and lecture pages from the course's slides) is a
 * separate rule, `ai_study`. It is not asked here; it is set where cards and
 * lecture pages are offered.
 *
 * Plain data in, one callback out: the page passes
 * `setPolicy={setCourseAiPolicy.bind(null, course.id)}` from
 * `src/app/(app)/assignments/[id]/policy-actions.ts`.
 */
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { assignmentHelp } from "@/lib/ai-policy";
import type { AiPolicy, PolicyResult } from "@/app/(app)/assignments/[id]/policy-actions";

export type { AiPolicy };
export type PolicyAnswer = "yes" | "explain" | "no" | "not_sure";

/** Shown instead of the chat when she answered "No" (`ai_assignments` is "off"). */
export const AI_OFF_LINE = "This course does not allow AI help on assignments. Hand-in works as usual.";
/** Shown instead of the chat while she has not said ("unknown"). Never claims the course forbids AI. */
export const AI_UNKNOWN_LINE = "We don't know this course's rule on AI help yet. Hand-in works as usual.";
export const EXPLAIN_ONLY_LINE = "Explain-only: this course does not allow AI-written homework.";
/**
 * The chat endpoint's 403 (`ai_off_for_assignments`) covers both "off" and "unknown", so its
 * sentence says only what is true in both: the chat is off here.
 */
export const AI_CHAT_OFF_LINE = "AI help is off for this course's assignments. Hand-in works as usual.";

/** The line under the card for each state; null where AI help is fully allowed. */
export function policyLine(policy: AiPolicy): string | null {
  if (policy === "off") return AI_OFF_LINE;
  if (isExplainOnly(policy)) return EXPLAIN_ONLY_LINE;
  if (chatHidden(policy)) return AI_UNKNOWN_LINE;
  return null;
}

/** What each button stores in `courses.ai_assignments`. */
export const ANSWER_POLICY: Record<PolicyAnswer, AiPolicy> = {
  yes: "allowed",
  explain: "explain",
  no: "off",
  not_sure: "unknown",
};

/** True when the page shows no chat for this course: AI help is off, or she has not said yet. */
export function chatHidden(policy: AiPolicy): boolean {
  return assignmentHelp({ aiAssignments: policy }) === "off";
}

/**
 * True when the chat is there but only explains: no AI-written homework, and
 * none of the course's text goes to a hosted AI.
 */
export function isExplainOnly(policy: AiPolicy): boolean {
  return assignmentHelp({ aiAssignments: policy }) === "explain";
}

export type AiPolicyCardProps = {
  courseName: string;
  /** The course's `ai_assignments` as the server read it. */
  policy: AiPolicy;
  /** Stores the new value. Usually the bound server action. */
  setPolicy: (policy: AiPolicy) => Promise<PolicyResult>;
  className?: string;
};

const BUTTONS: { answer: PolicyAnswer; label: string }[] = [
  { answer: "yes", label: "Yes" },
  { answer: "explain", label: "Only to explain" },
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
  // The line under the card: none where AI help is fully allowed.
  const line = policyLine(policy);

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

  if (!asking && !line) return null;

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
      {line && (
        <p
          className="text-[14px] leading-[1.45] text-ink-2"
          data-testid={
            line === AI_OFF_LINE ? "ai-policy-off" : line === EXPLAIN_ONLY_LINE ? "ai-policy-explain-only" : "ai-policy-unknown"
          }
        >
          {line}
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

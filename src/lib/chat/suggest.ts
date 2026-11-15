/**
 * Which step the assignment chat suggests next (M2-17).
 *
 * A fixed ladder, no AI-chosen suggestions. Pure: same input, same label.
 * The prototype's "Run both forecasts" step is left out because the chat
 * cannot run calculations.
 *
 * The course's AI rule is read through `assignmentHelp` (M2-27), so only a
 * course marked "allowed" is offered "Draft it with me"; "explain", "off" and
 * "unknown" (not answered yet) never are.
 */
import { assignmentHelp, type AiAssignments } from "@/lib/ai-policy";

/** The only thing this function needs from a chat message. */
export type SuggestMessage = { readonly role: "user" | "assistant" };

export type SuggestInput = {
  /** The chat so far. "Asked" means at least one message from her. */
  readonly messages: readonly SuggestMessage[];
  /** A draft exists for this assignment. */
  readonly hasDraft: boolean;
  /** The assignment has been handed in. */
  readonly handedIn: boolean;
  /** The course's `ai_assignments`, as stored. */
  readonly aiAssignments: AiAssignments;
  /** The school's LMS name from `src/lib/schools.ts`, e.g. "MyCourses". */
  readonly lmsName: string;
};

/**
 * Returns the label of the suggestion chip.
 *
 * Precedence, first match wins: handed in > draft exists > asked > nothing
 * asked. A draft that exists while drafting is not allowed (for example the
 * answer was changed to "No" after drafting) still suggests handing in: the
 * draft is hers to submit, and handing in writes no new AI text.
 */
export function nextSuggestion({
  messages,
  hasDraft,
  handedIn,
  aiAssignments,
  lmsName,
}: SuggestInput): string {
  if (handedIn) return "Back to home";
  if (hasDraft) return `Hand in to ${lmsName}`;
  const asked = messages.some((m) => m.role === "user");
  if (!asked) return "What exactly is asked?";
  return assignmentHelp({ aiAssignments }) === "allowed" ? "Draft it with me" : "Quiz me on this";
}

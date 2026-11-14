import { describe, expect, it } from "vitest";
import { nextSuggestion, type SuggestInput } from "./suggest";

const user = { role: "user" } as const;
const assistant = { role: "assistant" } as const;

function input(over: Partial<SuggestInput> = {}): SuggestInput {
  return {
    messages: [],
    hasDraft: false,
    handedIn: false,
    aiPolicy: "allowed",
    lmsName: "MyCourses",
    ...over,
  };
}

describe("nextSuggestion: the five states", () => {
  it("nothing asked yet", () => {
    expect(nextSuggestion(input())).toBe("What exactly is asked?");
  });

  it("asked, no draft, drafting allowed", () => {
    expect(nextSuggestion(input({ messages: [user, assistant] }))).toBe(
      "Draft it with me",
    );
  });

  it("asked, drafting not allowed", () => {
    expect(
      nextSuggestion(input({ messages: [user], aiPolicy: "not_allowed" })),
    ).toBe("Quiz me on this");
  });

  it("draft exists, not handed in", () => {
    expect(nextSuggestion(input({ messages: [user], hasDraft: true }))).toBe(
      "Hand in to MyCourses",
    );
  });

  it("handed in", () => {
    expect(
      nextSuggestion(input({ messages: [user], hasDraft: true, handedIn: true })),
    ).toBe("Back to home");
  });
});

describe("nextSuggestion: edge cases and precedence", () => {
  it("only assistant messages do not count as asked", () => {
    expect(nextSuggestion(input({ messages: [assistant, assistant] }))).toBe(
      "What exactly is asked?",
    );
  });

  it("unknown policy is explain-only", () => {
    expect(
      nextSuggestion(input({ messages: [user], aiPolicy: "unknown" })),
    ).toBe("Quiz me on this");
  });

  it("nothing asked wins over policy", () => {
    expect(nextSuggestion(input({ aiPolicy: "not_allowed" }))).toBe(
      "What exactly is asked?",
    );
  });

  it("uses the school's LMS name", () => {
    expect(nextSuggestion(input({ hasDraft: true, lmsName: "Moodle" }))).toBe(
      "Hand in to Moodle",
    );
  });

  it("a draft with drafting not allowed still suggests handing in", () => {
    expect(
      nextSuggestion(
        input({ messages: [user], hasDraft: true, aiPolicy: "not_allowed" }),
      ),
    ).toBe("Hand in to MyCourses");
  });

  it("a draft wins even before anything is asked", () => {
    expect(nextSuggestion(input({ hasDraft: true }))).toBe(
      "Hand in to MyCourses",
    );
  });

  it("handed in wins over everything", () => {
    for (const aiPolicy of ["unknown", "allowed", "not_allowed"] as const) {
      for (const hasDraft of [true, false]) {
        for (const messages of [[], [user]]) {
          expect(
            nextSuggestion(
              input({ handedIn: true, hasDraft, aiPolicy, messages }),
            ),
          ).toBe("Back to home");
        }
      }
    }
  });
});

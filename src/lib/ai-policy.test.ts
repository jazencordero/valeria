import { describe, expect, it } from "vitest";
import { assignmentHelp, studyAllowed, type AiAssignments, type AiStudy } from "./ai-policy";

describe("assignmentHelp", () => {
  it.each([
    ["unknown", "off"],
    ["off", "off"],
    ["explain", "explain"],
    ["allowed", "allowed"],
  ] as const)("ai_assignments '%s' is '%s'", (aiAssignments, help) => {
    expect(assignmentHelp({ aiAssignments })).toBe(help);
  });

  it("a value it does not know is off, never a yes", () => {
    for (const value of ["", "ALLOWED", "yes", "not_allowed", null, undefined]) {
      expect(assignmentHelp({ aiAssignments: value as unknown as AiAssignments })).toBe("off");
    }
  });

  it("does not look at the study rule", () => {
    const course = { aiAssignments: "off" as const, aiStudy: "allowed" as const };
    expect(assignmentHelp(course)).toBe("off");
  });
});

describe("studyAllowed", () => {
  it.each([
    ["unknown", false],
    ["not_allowed", false],
    ["allowed", true],
  ] as const)("ai_study '%s' is %s", (aiStudy, allowed) => {
    expect(studyAllowed({ aiStudy })).toBe(allowed);
  });

  it("a value it does not know is false", () => {
    for (const value of ["", "ALLOWED", "yes", "explain", null, undefined]) {
      expect(studyAllowed({ aiStudy: value as unknown as AiStudy })).toBe(false);
    }
  });

  it("does not look at the assignment rule: slides may be studied where homework help is off", () => {
    expect(studyAllowed({ aiAssignments: "off", aiStudy: "allowed" } as { aiStudy: AiStudy })).toBe(true);
    expect(studyAllowed({ aiAssignments: "allowed", aiStudy: "unknown" } as { aiStudy: AiStudy })).toBe(false);
  });
});

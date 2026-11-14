import { describe, expect, it } from "vitest";
import { attachFromPath, attachLabel, type AttachLookups } from "./attach";

const COURSE = "11111111-1111-4111-8111-111111111111";
const LECTURE = "22222222-2222-4222-8222-222222222222";
const ASSIGNMENT = "33333333-3333-4333-8333-333333333333";
const EXAM = "44444444-4444-4444-8444-444444444444";
const QUIZ = "55555555-5555-4555-8555-555555555555";

const lookups: AttachLookups = {
  courses: { [COURSE]: { name: "Strategic IT Management" } },
  lectures: { [LECTURE]: { n: 5, title: "Sourcing and vendors" } },
  assignments: { [ASSIGNMENT]: { name: "Assignment 3" } },
  exams: {
    [EXAM]: { kind: "exam", title: "Final", courseName: "Strategic IT Management" },
    [QUIZ]: { kind: "quiz", title: "Quiz 4", courseName: "Forecasting Methods" },
  },
};

describe("attachLabel", () => {
  it("names each kind", () => {
    expect(attachLabel({ attach: { kind: "general", id: null } }, lookups)).toBe("General");
    expect(attachLabel({ attach: { kind: "lecture", id: LECTURE } }, lookups)).toBe("Lecture 5 · Sourcing and vendors");
    expect(attachLabel({ attach: { kind: "assignment", id: ASSIGNMENT } }, lookups)).toBe("Assignment 3");
    expect(attachLabel({ attach: { kind: "exam", id: EXAM } }, lookups)).toBe("Exam · Strategic IT Management");
    expect(attachLabel({ attach: { kind: "course", id: COURSE } }, lookups)).toBe("Strategic IT Management");
  });

  it("uses a quiz's own title", () => {
    expect(attachLabel({ attach: { kind: "exam", id: QUIZ } }, lookups)).toBe("Quiz 4 · Forecasting Methods");
  });

  it("falls back to General when the thing is gone or unknown", () => {
    expect(attachLabel({ attach: { kind: "lecture", id: null } }, lookups)).toBe("General");
    expect(attachLabel({ attach: { kind: "course", id: LECTURE } }, lookups)).toBe("General");
    expect(attachLabel({ attach: { kind: "exam", id: EXAM } }, {})).toBe("General");
  });
});

describe("attachFromPath", () => {
  it("attaches to the lecture by course and number", () => {
    expect(attachFromPath(`/courses/${COURSE}/lectures/5`)).toEqual({ kind: "lecture", courseId: COURSE, n: 5 });
    expect(attachFromPath(`/courses/${COURSE}/lectures/12/`)).toEqual({ kind: "lecture", courseId: COURSE, n: 12 });
  });

  it("attaches to the course from its page and its grade page", () => {
    expect(attachFromPath(`/courses/${COURSE}`)).toEqual({ kind: "course", id: COURSE });
    expect(attachFromPath(`/grades/${COURSE}`)).toEqual({ kind: "course", id: COURSE });
    expect(attachFromPath(`/courses/${COURSE}/lectures/zero`)).toEqual({ kind: "course", id: COURSE });
    expect(attachFromPath(`/courses/${COURSE}/lectures/0`)).toEqual({ kind: "course", id: COURSE });
  });

  it("attaches to the assignment and the exam", () => {
    expect(attachFromPath(`/assignments/${ASSIGNMENT}`)).toEqual({ kind: "assignment", id: ASSIGNMENT });
    expect(attachFromPath(`/exams/${EXAM}?tab=notes#top`)).toEqual({ kind: "exam", id: EXAM });
  });

  it("is general everywhere else", () => {
    for (const p of [
      "/",
      "/home",
      "/home?arrive=1",
      "/courses",
      "/assignments",
      "/exams",
      "/grades",
      "/notes",
      "/calendar",
      "/settings",
      `/study/${EXAM}`,
      "/exams/not-a-uuid",
      "",
    ]) {
      expect(attachFromPath(p), p).toEqual({ kind: "general" });
    }
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/exams/mock/actions", () => ({ startMockExamAction: vi.fn() }));
import { lostPoints } from "./result";
import { sampleAttempt, sampleExam } from "./sample-exam";

describe("where she lost points", () => {
  it("groups lost points by lecture, biggest first, with blank and wrong told apart", () => {
    const groups = lostPoints(
      sampleExam,
      sampleAttempt({ trueFalse: { 0: true, 1: true, 2: true, 3: false, 4: true, 5: false }, ticks: {} }),
    );
    // Carrots answered true: wrong, 2 points lost (the −1 and the point not earned).
    const roots = groups.find((g) => g.lecture.page === "roots");
    expect(roots?.items[0].tag).toBe("−1");
    expect(roots?.lost).toBe(2);
    expect(groups[0].lost).toBeGreaterThanOrEqual(groups[groups.length - 1].lost);
    expect(groups.some((g) => g.lecture.page === "ideas" && g.lost === 6)).toBe(true);
  });
});

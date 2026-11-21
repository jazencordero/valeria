import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExamHeader } from "./exam-header";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, back: () => {}, prefetch: () => {} }) }));

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ExamHeader", () => {
  it("keeps the title at least 240 px wide, so a short chip wraps under it on a phone", () => {
    render(<ExamHeader course="Invented Methods in Invented Analytics" sub="Invented exam · Fri 4 Dec" forecast={6} verdict="Starts Tue 24 Nov" backHref="/exams" />);
    const title = screen.getByTestId("exam-header-title");
    expect(title.className).toContain("flex-[1_1_240px]");
    expect(title.className).toContain("min-w-0");
    expect(document.body.textContent).toContain("6% right today. Starts Tue 24 Nov.");
  });

  it("for an exam that is over says only that, with no ring and no \"right today\"", () => {
    render(<ExamHeader course="Invented Course" sub="Invented exam · Mon 7 Dec" forecast={64} verdict="This exam is over." over backHref="/exams" />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("This exam is over.");
    expect(text).not.toContain("right today");
    expect(text).not.toContain("64");
    expect(screen.queryByLabelText("64 percent forecast")).toBeNull();
  });

  it("keeps the ring and \"right today\" while the exam is not over", () => {
    render(<ExamHeader course="Invented Course" sub="Invented exam · Mon 7 Dec" forecast={64} verdict="On track with a bite a day" backHref="/exams" />);
    expect(document.body.textContent).toContain("64% right today. On track with a bite a day.");
    expect(screen.getByLabelText("64 percent forecast")).toBeDefined();
  });
});

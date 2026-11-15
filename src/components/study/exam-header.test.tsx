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
});

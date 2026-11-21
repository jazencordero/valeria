import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDone, type SessionDoneProps } from "./done";
import { byDay } from "@/lib/dates";
import { freeSkipsLeft, weekOf, weeksInARow } from "@/lib/study/week";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, back: () => {}, prefetch: () => {} }) }));

beforeEach(() => {
  // jsdom has no Web Animations.
  (Element.prototype as unknown as { getAnimations: () => [] }).getAnimations ??= () => [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = new Date("2026-11-16T12:00:00Z");
const days = ["2026-11-16T10:00:00Z"];
const props: Omit<SessionDoneProps, "focusTitle"> = {
  result: { cards: 7, seconds: 85, best: 3, perfect: false, climbs: [], reviews: [] },
  mode: "bite",
  examShort: "Invented course",
  forecastBefore: 3,
  forecastAfter: 4,
  // 85% is a 4 on the generic scale; this exam's own target is a 5.
  target: 85,
  targetGrade: 5,
  planEnd: 42.5,
  examDay: "Mon 23 Nov",
  concepts: {},
  week: weekOf(days, 4, NOW),
  weeksInARow: weeksInARow(days, 4, NOW),
  freeSkipsLeft: freeSkipsLeft(days, 4, NOW),
  dayNew: true,
  goalNew: false,
  nextBiteMinutes: 4,
  backLabel: "Back to the exam",
};

describe("SessionDone forecast", () => {
  it("names the exam's own target grade, a whole percent and the exam's date", () => {
    render(<SessionDone {...props} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("A 5");
    expect(text).not.toContain("A 4");
    expect(text).toContain("Keep a bite a day and you land around 43% on Mon 23 Nov.");
  });

  it("on the exam's own day says today, not on a weekday", () => {
    // An invented exam at 15:00 Helsinki on Monday 16 Nov; NOW is 14:00 Helsinki that day.
    const examDay = byDay(new Date("2026-11-16T13:00:00Z"), NOW);
    render(<SessionDone {...props} examDay={examDay} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Keep a bite a day and you land around 43% today.");
    expect(text).not.toContain("on today");
    expect(text).not.toContain("Monday");
  });

  it("says what is left of today, and offers it in one go, only when told", () => {
    const { rerender } = render(<SessionDone {...props} />);
    expect(screen.queryByTestId("today-left")).toBeNull();
    expect(document.body.textContent).toContain("Bite done.");
    expect(screen.getByRole("button", { name: "One more bite · 4 min" })).toBeDefined();
    rerender(<SessionDone {...props} long moreInOneGo todayLeft="About 12 minutes of today’s plan left" />);
    expect(screen.getByTestId("today-left").textContent).toBe("About 12 minutes of today’s plan left");
    expect(document.body.textContent).toContain("Session done.");
    expect(screen.getByRole("button", { name: "Do them in one go" })).toBeDefined();
    rerender(<SessionDone {...props} long result={{ ...props.result, perfect: true }} />);
    expect(document.body.textContent).toContain("Perfect session.");
    // Stopped part-way, even after only right answers, it says so.
    rerender(<SessionDone {...props} long stopped result={{ ...props.result, perfect: true }} />);
    expect(document.body.textContent).toContain("Session stopped.");
    expect(document.body.textContent).not.toContain("Perfect session.");
    // Today's plan done: no line about what is left, whatever was passed.
    rerender(<SessionDone {...props} long nextBiteMinutes={null} todayLeft="About 12 minutes of today’s plan left" />);
    expect(screen.queryByTestId("today-left")).toBeNull();
    expect(document.body.textContent).toContain("That is today's plan done. Rest counts too.");
  });

  it("says Target when the exam has no grade target", () => {
    render(<SessionDone {...props} targetGrade={null} />);
    expect(screen.getByText("Target")).toBeDefined();
    expect(document.body.textContent ?? "").not.toMatch(/\bA [0-5]\b/);
  });
});

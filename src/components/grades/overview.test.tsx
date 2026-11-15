import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Overview } from "./overview";
import { GradesListView } from "./grades-list";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, back: () => {}, prefetch: () => {} }) }));

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base = { target: 5 as const, onTargetChange: () => {}, mattersMost: { name: "Exam", weight: 0.6 } };
const count = (re: RegExp) => (document.body.textContent ?? "").match(new RegExp(re.source, re.flags + "g"))?.length ?? 0;

describe("Overview says what she needs once", () => {
  it("within reach: the heading says the percent and no row repeats it", () => {
    render(<Overview {...base} verdict={{ kind: "within", need: 90 }} />);
    expect(count(/need about/i)).toBe(1);
    expect(screen.queryByTestId("overview-need")).toBeNull();
    expect(screen.getByTestId("overview-mm").textContent).toContain("Exam matters most");
  });

  it("out of reach and all graded: no row repeats the heading", () => {
    render(<Overview {...base} verdict={{ kind: "out", need: 120, best: 4.6, nextGrade: 4, nextGradeNeed: 95 }} />);
    expect(count(/best possible/i)).toBe(1);
    cleanup();
    render(<Overview {...base} verdict={{ kind: "all_graded" }} />);
    expect(count(/everything is graded/i)).toBe(1);
  });

  it("on track: the heading names no percent, so the row says it", () => {
    render(<Overview {...base} verdict={{ kind: "on", need: 72 }} />);
    expect(screen.getByTestId("overview-need").textContent).toMatch(/You need about 72% on what is left/);
  });
});

describe("Grades list row", () => {
  it("names no target for a course marked in points", () => {
    render(
      <GradesListView
        lmsName="Invented LMS"
        overall={null}
        courses={[
          { id: "a", href: "/grades/a", name: "Invented points course", color: "butter", status: "early", target: null, trajectory: null },
          { id: "b", href: "/grades/b", name: "Invented percent course", color: "butter", status: "within", target: 4, trajectory: null },
        ]}
      />,
    );
    expect(screen.getByTestId("grades-row-a").textContent).not.toMatch(/aiming for/i);
    expect(screen.getByTestId("grades-row-b").textContent).toMatch(/aiming for 4/);
  });
});

describe("Home grades card row", () => {
  it("marks no target step and names none for a course marked in points", async () => {
    const { GradesCard } = await import("@/components/home/grades-card");
    render(
      <GradesCard
        lmsName="Invented LMS"
        courses={[{ id: "a", href: "/grades/a", name: "Invented points course", status: "early", target: null, trajectory: null }]}
      />,
    );
    const row = screen.getByTestId("grades-card-row-a");
    expect(row.textContent).not.toMatch(/aiming for/i);
    expect(row.querySelector("i[data-target]")).toBeNull();
  });
});

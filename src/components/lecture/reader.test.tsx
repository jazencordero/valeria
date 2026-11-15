import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LectureReader } from "./reader";

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Made-up lecture.
const base = { course: "Sample course", n: 2, title: "Sample lecture", lmsName: "MyLMS", status: "ready" as const, breath: "One line." };

describe("LectureReader meta line", () => {
  it("puts a dot between the reading time and the slide count", () => {
    const { container } = render(<LectureReader {...base} minutes={4} minutesWithHelp={17} slideCount={37} />);
    const meta = container.querySelector(".lec-meta")!;
    expect(meta.textContent).toBe("4 min · 17 with all the help·From 37 slides");
    expect(meta.querySelector(".lec-meta-dot")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("has no dot when only one of them is there", () => {
    const { container } = render(<LectureReader {...base} slideCount={37} />);
    expect(container.querySelector(".lec-meta-dot")).toBeNull();
  });
});

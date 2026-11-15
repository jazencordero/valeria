import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/home", useRouter: () => ({ push: () => {}, prefetch: () => {} }) }));

const { SideNavView } = await import("./side-nav");

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

describe("SideNavView course list", () => {
  // An auto-sized grid column grows to the longest name, so `truncate` never cut it
  // and long names were clipped mid-word with no ellipsis.
  it("sizes its one column to the list, so long names end in an ellipsis", () => {
    render(
      <SideNavView
        pathname="/home"
        user={{ firstName: "Sam", school: null }}
        courses={[{ id: "c1", name: "A made-up course with a very long name indeed", color: "sky" }]}
      />,
    );
    const list = screen.getByTestId("side-courses");
    expect(list.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(list.querySelector("span")?.className).toContain("truncate");
  });
});

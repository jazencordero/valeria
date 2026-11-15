import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PushToggle } from "./push-toggle";

afterEach(() => {
  cleanup();
});

describe("PushToggle switch knob and motion", () => {
  it("drops the knob's transform transition under reduced motion", () => {
    render(<PushToggle publicKey={null} demo />);
    const knob = screen.getByRole("switch").querySelector("span > span");
    expect(knob).not.toBeNull();
    // jsdom applies no Tailwind or media queries: check the class Tailwind
    // compiles to `@media (prefers-reduced-motion: reduce) { transition-property: none }`.
    expect(knob!.className).toContain("transition-transform");
    expect(knob!.className).toContain("motion-reduce:transition-none");
  });
});

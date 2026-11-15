// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FAB_CLEAR, FAB_CLEAR_WIDE } from "./fab";

const css = readFileSync(new URL("./notepad.css", import.meta.url), "utf8");
const px = (cls: string) => Number(cls.match(/pb-\[(\d+)px\]/)?.[1]);

// The phone tab bar is 58 px tall; the button is 56 px.
const TAB_BAR = 58;
const FAB = 56;

describe("room left for the notes button", () => {
  it("clears the button on a phone, where it sits above the tab bar", () => {
    const bottom = Number(css.match(/\.pad-fab \{[^}]*bottom: calc\((\d+)px/)?.[1]);
    expect(bottom).toBeGreaterThan(0);
    expect(px(FAB_CLEAR)).toBeGreaterThan(bottom + FAB - TAB_BAR + 8);
  });

  it("clears the button on wide screens", () => {
    const bottom = Number(css.match(/\.pad-fab \{ right: 24px; bottom: (\d+)px; \}/)?.[1]);
    expect(bottom).toBeGreaterThan(0);
    expect(px(FAB_CLEAR_WIDE)).toBeGreaterThan(bottom + FAB + 8);
  });
});

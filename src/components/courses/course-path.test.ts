// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./course-path.css", import.meta.url), "utf8");
const rule = (sel: string) => css.match(new RegExp(`\\.cpath \\${sel}\\{([^}]*)\\}`))?.[1] ?? "";

describe("course path labels", () => {
  // Labels are centred on their stops, so a tall label runs into the next stop's label.
  it("keeps a stop's summary to one line", () => {
    expect(rule(".cp-lbl-c")).toMatch(/-webkit-line-clamp:\s*1/);
    expect(rule(".cp-lbl-c")).toMatch(/overflow:\s*hidden/);
  });

  it("keeps a stop's title to two lines", () => {
    expect(rule(".cp-lbl-t")).toMatch(/-webkit-line-clamp:\s*2/);
  });
});

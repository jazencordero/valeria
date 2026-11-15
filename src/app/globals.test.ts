import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// globals.css starts with `@import "tailwindcss"`, which jsdom cannot load, so
// this takes only the fast-switch rule out of the file and puts it on the page.
const css = readFileSync(resolve(__dirname, "globals.css"), "utf8");
const fastRule = css.match(/:root\[data-fast\] \*,[^{]*\{[^}]*\}/)?.[0] ?? "";
// jsdom's selector engine drops a rule whose selector list has ::before or
// ::after, so the page gets the rule's own declarations on its first selector.
const fastForJsdom = fastRule.replace(/^[^{]*/, ":root[data-fast] * ");

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  delete document.documentElement.dataset.fast;
});

function hoveredCard(): HTMLElement {
  const style = document.createElement("style");
  // A card's own hover lift and fade, as a component stylesheet would set it
  // (jsdom has no :hover, so the timing sits on the card itself).
  style.textContent =
    ".card { transition-property: transform, background-color; transition-duration: 280ms, 180ms; transition-delay: 40ms; }\n" +
    fastForJsdom;
  document.head.append(style);
  const card = document.createElement("a");
  card.className = "card";
  document.body.append(card);
  card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  return card;
}

describe("globals.css fast switch", () => {
  it("has one rule for every element and its ::before and ::after", () => {
    expect(fastRule).toContain(":root[data-fast] *::before");
    expect(fastRule).toContain(":root[data-fast] *::after");
    for (const prop of ["transition-duration", "transition-delay", "animation-duration", "animation-delay"]) {
      expect(fastRule).toContain(`${prop}: 0s !important`);
    }
    // Durations, not `none`, so CSS animations still end and send their events.
    expect(fastRule).not.toMatch(/animation:\s*none|transition:\s*none/);
  });

  it("gives a hovered card transition-duration 0s with the fast switch set", () => {
    document.documentElement.dataset.fast = "1";
    const card = hoveredCard();
    const s = getComputedStyle(card);
    expect(s.transitionDuration).toBe("0s");
    expect(s.transitionDelay).toBe("0s");
  });

  it("leaves the card's own timing alone without the fast switch", () => {
    const card = hoveredCard();
    expect(getComputedStyle(card).transitionDuration).toBe("280ms, 180ms");
  });
});

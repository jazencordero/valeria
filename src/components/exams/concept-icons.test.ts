import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CONCEPT_ICON_NAMES, ConceptIcon, iconFor, type ConceptIconName } from "./concept-icons";

describe("iconFor", () => {
  const cases: [string, ConceptIconName][] = [
    ["IT governance", "governance"],
    ["Governing boards", "governance"],
    ["Decision rights", "decision"],
    ["Sourcing and vendors", "sourcing"],
    ["Outsourcing", "sourcing"],
    ["Contracts", "contract"],
    ["SLAs", "contract"],
    ["Service levels (SLA)", "contract"],
    ["Data quality", "data"],
    ["IT value and investment", "value"],
    ["Valuation", "value"],
    ["Money and banking", "value"],
    ["Time series", "timeSeries"],
    ["Time-series models", "timeSeries"],
    ["Differencing", "difference"],
    ["Difference in means", "difference"],
    ["Reading a chart", "chart"],
    ["Control charts", "chart"],
  ];

  it.each(cases)("%s -> %s", (name, icon) => {
    expect(iconFor(name)).toBe(icon);
  });

  it("puts the more specific phrase first", () => {
    expect(iconFor("Data governance")).toBe("governance");
    expect(iconFor("Time series data")).toBe("timeSeries");
  });

  it("does not match keywords inside other words", () => {
    expect(iconFor("Translation")).toBe("dot");
    expect(iconFor("Resources")).toBe("dot");
  });

  it("falls back to the neutral dot", () => {
    expect(iconFor("Strategic alignment")).toBe("dot");
    expect(iconFor("")).toBe("dot");
  });
});

describe("ConceptIcon", () => {
  it("draws every icon as a hidden 24 px grid svg", () => {
    for (const name of CONCEPT_ICON_NAMES) {
      const html = renderToStaticMarkup(createElement(ConceptIcon, { name }));
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain(`data-icon="${name}"`);
      expect(html).toMatch(/<(path|circle|ellipse)/);
    }
  });

  it("takes a size", () => {
    const html = renderToStaticMarkup(createElement(ConceptIcon, { name: "chart", size: 22 }));
    expect(html).toContain('width="22"');
    expect(html).toContain('height="22"');
  });

  it("has the dot last, after the nine keyword icons", () => {
    expect(CONCEPT_ICON_NAMES).toHaveLength(10);
    expect(CONCEPT_ICON_NAMES.at(-1)).toBe("dot");
  });
});

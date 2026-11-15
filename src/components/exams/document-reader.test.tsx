// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentReader, documentPieces, emphasisParts, LINE_BREAK } from "@/components/exams/document-reader";

const EXAM = "00000000-0000-4000-8000-000000000054";
const read = (bodyMd: string) => renderToStaticMarkup(<DocumentReader examId={EXAM} title="Mock quiz" minutes={1} bodyMd={bodyMd} />);

describe("document reader: rules", () => {
  it("draws --- as a rule between two parts, not as text", () => {
    const html = read("## Questions\n\nFirst part.\n\n---\n\n## Answers\n\nSecond part.");
    expect(html.match(/<hr/g)).toHaveLength(1);
    expect(html).not.toContain("---");
    expect(html.indexOf("First part.")).toBeLessThan(html.indexOf("<hr"));
    expect(html.indexOf("<hr")).toBeLessThan(html.indexOf("Answers"));
  });

  it("knows *** and ___ too, and leaves a table's own rule line to the table", () => {
    expect(documentPieces("a\n\n***\n\nb\n\n_ _ _\n\nc").filter((p) => p.type === "hr")).toHaveLength(2);
    const pieces = documentPieces("| Day | Task |\n|---|---|\n| Mon | Read |");
    expect(pieces.map((p) => p.type)).toEqual(["table"]);
  });
});

describe("document reader: emphasis", () => {
  it("sets *word* in italics and shows no stars", () => {
    const html = read("Read the question *twice* before you answer.");
    expect(html).toContain("<em>twice</em>");
    expect(html).not.toContain("*");
  });

  it("keeps bold, and emphasis inside a list item", () => {
    const html = read("- **Always** check the *sign* first");
    expect(html).toContain("Always</span></span></strong>");
    expect(html).toContain("<em>sign</em>");
  });

  it("leaves products, lone stars, code and underscores alone", () => {
    expect(emphasisParts("2*3*4 = 24")).toEqual([{ text: "2*3*4 = 24" }]);
    expect(emphasisParts("a * b * c")).toEqual([{ text: "a * b * c" }]);
    expect(emphasisParts("y_t = a_t + 0.5 a_(t-1)")).toEqual([{ text: "y_t = a_t + 0.5 a_(t-1)" }]);
    const html = read("Type `a*b*c` and x_1 = 2, x_2 = 3.");
    expect(html).not.toContain("<em>");
    expect(html).toContain("a*b*c");
    expect(html).toContain("x_1 = 2, x_2 = 3.");
  });

  it("splits several in one line", () => {
    expect(emphasisParts("*one* and *two words*.")).toEqual([
      { text: "one", em: true },
      { text: " and " },
      { text: "two words", em: true },
      { text: "." },
    ]);
  });
});

describe("document reader: lines of one paragraph", () => {
  it("keeps (a), (b), (c) on their own lines", () => {
    const html = read("A shop sells tea.\n(a) Name the trend. (1p)\n(b) Forecast week 5. (2p)\n\nNext paragraph.");
    expect(html.match(/<br\/>/g)).toHaveLength(2);
    expect(html).toMatch(/A shop sells tea\.<\/span><\/span><span><br\/><span>\(a\) Name the trend\. \(1p\)/);
    expect(html).not.toContain(LINE_BREAK);
    // Still one paragraph, and the next one is its own.
    expect(html.match(/<p class="mt-3">/g)).toHaveLength(2);
  });

  it("does not break inside a list item, a table or after a heading", () => {
    const html = read("## Plan\nRead this.\n\n- one\n  still one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    expect(html).not.toContain("<br");
    expect(html).toContain("one still one");
    expect(html).not.toContain(LINE_BREAK);
  });

  it("starts a paragraph cleanly after a list with no blank line between", () => {
    const html = read("- one\n- two\nThen this line.\nAnd this one.");
    expect(html.match(/<br\/>/g)).toHaveLength(1);
    expect(html).toContain("<li><span><span>two</span></span></li>");
  });

  it("keeps a one-line caption above a table as its caption", () => {
    const pieces = documentPieces("Scores\n| A | B |\n|---|---|\n| 1 | 2 |");
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ type: "table", caption: [{ text: "Scores" }] });
  });

  it("still drops a first heading that repeats the title", () => {
    expect(documentPieces("# Mock quiz\n\nText", "Mock quiz").map((p) => p.type)).toEqual(["p"]);
  });
});

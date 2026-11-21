import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ExamFigure } from "./figure";
import { Formula, PaperHeader, PaperTable, PartLine } from "./paper";
import { sampleExam } from "./sample-exam";

afterEach(cleanup);

describe("the paper", () => {
  it("has the two-line header left and right", () => {
    render(<PaperHeader header={sampleExam.paperHeader} />);
    const h = screen.getByTestId("paper-header");
    expect(h.textContent).toContain("SAMPLE101 Sample course");
    expect(h.textContent).toContain("A Teacher");
  });

  it("puts the points after the part in the teacher's form", () => {
    render(<PartLine label="(a)" text="Explain the idea." points={1.5} />);
    expect(screen.getByTestId("paper-points").textContent).toBe("(1.5p)");
  });

  it("centres a formula on its own line, read out whole", () => {
    render(<Formula>y = 2x + 1.</Formula>);
    expect(screen.getByRole("math", { name: "y = 2x + 1." })).toBeTruthy();
  });

  it("draws a table with its head and rows", () => {
    render(<PaperTable table={{ columns: ["Model", "Score"], rows: [["One", "0.5"]] }} />);
    expect(screen.getByRole("columnheader", { name: "Score" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "One" })).toBeTruthy();
  });

  it("draws a figure as SVG named by its alt", () => {
    const q4 = sampleExam.questions[3];
    if (q4.type !== "written" || !q4.sections[0].figure) throw new Error("sample");
    render(<ExamFigure figure={q4.sections[0].figure} />);
    expect(screen.getByRole("img", { name: "Two classes of points." })).toBeTruthy();
  });
});

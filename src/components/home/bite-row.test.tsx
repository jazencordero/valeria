import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BiteRow } from "./bite-row";

afterEach(cleanup);

describe("BiteRow with Do them in one go", () => {
  it("gives the pill a 44 px tap area and, on a phone, its own line under the text", () => {
    render(
      <BiteRow state="bite" minutes={3} cards={5} gain={2} forWhat="the exam on 23 Nov" href="/study/new?exam=x&kind=bite" longHref="/study/new?exam=x&kind=long" />,
    );
    const long = screen.getByTestId("bite-row-long");
    expect(long.textContent).toBe("Do them in one go");
    expect(long.getAttribute("href")).toBe("/study/new?exam=x&kind=long");
    // 27 px pill + 2 × 9 px = 45 px of tap target.
    expect(long.className).toContain("before:-inset-y-[9px]");
    expect(long.className).toContain("whitespace-nowrap");
    const actions = screen.getByTestId("bite-row-actions");
    expect(actions.className).toContain("col-span-2");
    expect(actions.className).toContain("min-[480px]:col-span-1");
  });
});

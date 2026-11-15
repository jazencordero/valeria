import { describe, expect, it } from "vitest";
import {
  CLOSE_MS,
  CLOSE_WORK,
  OPEN_MS,
  OPEN_WORK,
  WORK_NAME,
  WORK_SOURCE_ATTR,
  WORK_TRANSITION_CSS,
  WORK_VT_ATTR,
  hasViewTransitions,
  insetFor,
  workMotion,
  workSource,
} from "./shared";

describe("insetFor", () => {
  const frame = { left: 240, top: 0, width: 1040, height: 800 };

  it("clips the frame down to the card, with the card's corners", () => {
    const card = { left: 300, top: 180, width: 600, height: 220 };
    expect(insetFor(card, frame)).toBe("inset(180px 380px 400px 60px round 20px)");
  });

  it("clamps a card that reaches outside the frame", () => {
    const card = { left: 200, top: -40, width: 1200, height: 900 };
    expect(insetFor(card, frame, 0)).toBe("inset(0px 0px 0px 0px round 0px)");
  });
});

describe("workMotion", () => {
  it("is the clip only with full motion and view transitions", () => {
    expect(workMotion("full", true)).toBe("clip");
    expect(workMotion("full", false)).toBe("slide");
  });

  it("fades when calm and does nothing under the test switch", () => {
    expect(workMotion("calm", true)).toBe("fade");
    expect(workMotion("calm", false)).toBe("fade");
    expect(workMotion("instant", true)).toBe("none");
  });
});

describe("the transition's names and CSS", () => {
  it("marks the card with the workspace's path", () => {
    expect(workSource("/assignments/a1")).toEqual({ [WORK_SOURCE_ATTR]: "/assignments/a1" });
  });

  it("names the page area only while the transition's type is on <html>", () => {
    expect(WORK_TRANSITION_CSS).toContain(`html[${WORK_VT_ATTR}] #main { view-transition-name: ${WORK_NAME}; }`);
    expect(WORK_TRANSITION_CSS).not.toMatch(/(^|\n)#main/);
  });

  it("grows for 520 ms and shrinks for 420 ms", () => {
    expect(OPEN_MS).toBe(520);
    expect(CLOSE_MS).toBe(420);
    expect(WORK_TRANSITION_CSS).toContain(`[${WORK_VT_ATTR}="${OPEN_WORK}"]::view-transition-new(${WORK_NAME})`);
    expect(WORK_TRANSITION_CSS).toContain(`${OPEN_MS}ms`);
    expect(WORK_TRANSITION_CSS).toContain(`[${WORK_VT_ATTR}="${CLOSE_WORK}"]::view-transition-old(${WORK_NAME})`);
    expect(WORK_TRANSITION_CSS).toContain(`${CLOSE_MS}ms`);
  });

  it("does not use the tab transition's types", () => {
    expect(WORK_TRANSITION_CSS).not.toContain("tab-forward");
    expect(WORK_TRANSITION_CSS).not.toContain("active-view-transition-type");
  });

  it("finds no view transitions in jsdom", () => {
    expect(hasViewTransitions()).toBe(false);
  });
});

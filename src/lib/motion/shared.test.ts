import { describe, expect, it } from "vitest";
import {
  CLOSE_EXAM,
  CLOSE_MS,
  CLOSE_WORK,
  EXAM_CLOSE_MS,
  EXAM_OPEN_MS,
  EXAM_PAGE,
  OPEN_EXAM,
  OPEN_MS,
  OPEN_WORK,
  WORK_NAME,
  WORK_SOURCE_ATTR,
  WORK_TRANSITION_CSS,
  WORK_VT_ATTR,
  cardArrival,
  cardRevealPending,
  closeCardPage,
  hasViewTransitions,
  insetFor,
  leaveCardPage,
  openCardPage,
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

describe("a page that opens out of its card (exams, M4-14)", () => {
  it("grows for 360 ms and shrinks for 320 ms, under its own types", () => {
    expect(EXAM_OPEN_MS).toBe(360);
    expect(EXAM_CLOSE_MS).toBe(320);
    expect(EXAM_PAGE).toEqual({ open: OPEN_EXAM, close: CLOSE_EXAM, closeSlide: "close-exam-slide", openMs: 360 });
    expect(WORK_TRANSITION_CSS).toMatch(
      new RegExp(`\\[${WORK_VT_ATTR}="${OPEN_EXAM}"\\]::view-transition-new\\(${WORK_NAME}\\) \\{\\s*animation: 360ms`),
    );
    expect(WORK_TRANSITION_CSS).toMatch(
      new RegExp(`\\[${WORK_VT_ATTR}="${CLOSE_EXAM}"\\]::view-transition-old\\(${WORK_NAME}\\) \\{\\s*z-index: 1;\\s*animation: 320ms`),
    );
  });

  /** A page area with a card on it, scrolled down. */
  function scene() {
    document.body.innerHTML = `<main id="main"><article ${WORK_SOURCE_ATTR}="card-a"><button>Open</button></article></main>`;
    const main = document.getElementById("main")!;
    main.scrollTop = 240;
    return { main, card: main.querySelector("article")! as HTMLElement };
  }

  /** What a React click event gives the helpers. */
  function click(over: Partial<{ metaKey: boolean }> = {}) {
    const e = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {
        e.defaultPrevented = true;
      },
      stopPropagation: () => {},
      ...over,
    };
    return e as unknown as Parameters<typeof closeCardPage>[0] & { defaultPrevented: boolean };
  }

  it("always navigates, and under the test switch plays nothing", () => {
    const { card } = scene();
    let went = 0;
    openCardPage(card, "instant", () => went++);
    expect(went).toBe(1);
    expect(cardRevealPending()).toBe(false);
    expect(document.documentElement.hasAttribute(WORK_VT_ATTR)).toBe(false);
  });

  it("goes back to the page the card is on and puts the scroll where it was", async () => {
    const { main, card } = scene();
    window.history.replaceState(null, "", "/home");
    openCardPage(card, "instant", () => window.history.replaceState(null, "", "/exams/e1"));
    // The exam page is on screen: the card is gone, the page area is at its top.
    main.innerHTML = `<div id="page"><a href="/exams">Back</a></div>`;
    main.scrollTop = 0;
    const root = document.getElementById("page")!;
    expect(cardArrival(root)).toBe(0);

    const went: string[] = [];
    const e = click();
    closeCardPage(e, root.querySelector("a")!, "instant", root, (path) => {
      went.push(path);
      main.innerHTML = `<article ${WORK_SOURCE_ATTR}="card-a"></article>`;
    }, "/exams");
    expect(e.defaultPrevented).toBe(true);
    expect(went).toEqual(["/home"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(main.scrollTop).toBe(240);
  });

  it("falls back to the given page when the page was not opened from a card", () => {
    const { main } = scene();
    window.history.replaceState(null, "", "/exams/e2");
    main.innerHTML = `<div id="page"><a href="/exams">Back</a></div>`;
    const root = document.getElementById("page")!;
    cardArrival(root);
    const went: string[] = [];
    closeCardPage(click(), root.querySelector("a")!, "instant", root, (path) => went.push(path), "/exams");
    expect(went).toEqual(["/exams"]);
  });

  it("forgets the card once the page has been left", async () => {
    const { main, card } = scene();
    window.history.replaceState(null, "", "/home");
    openCardPage(card, "instant", () => window.history.replaceState(null, "", "/exams/e3"));
    main.innerHTML = `<div id="page"><a href="/exams">Back</a></div>`;
    const root = document.getElementById("page")!;
    cardArrival(root);
    leaveCardPage(root);
    root.remove();
    await new Promise((r) => setTimeout(r, 5));
    main.append(root);
    cardArrival(root);
    const went: string[] = [];
    closeCardPage(click(), root.querySelector("a")!, "instant", root, (path) => went.push(path), "/exams");
    expect(went).toEqual(["/exams"]);
  });

  it("leaves a click that opens a new tab alone", () => {
    const { main } = scene();
    main.innerHTML = `<div id="page"><a href="/exams">Back</a></div>`;
    const root = document.getElementById("page")!;
    const went: string[] = [];
    const e = click({ metaKey: true });
    closeCardPage(e, root.querySelector("a")!, "instant", root, (path) => went.push(path), "/exams");
    expect(e.defaultPrevented).toBe(false);
    expect(went).toEqual([]);
  });
});

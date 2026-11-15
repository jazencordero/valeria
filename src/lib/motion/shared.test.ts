import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSE_EXAM,
  CLOSE_LECTURE,
  LECTURE_CLOSE_MS,
  LECTURE_OPEN_MS,
  LECTURE_PAGE,
  OPEN_LECTURE,
  cardClosed,
  circleFor,
  CLOSE_MS,
  CLOSE_WORK,
  EXAM_CLOSE_MS,
  EXAM_OPEN_MS,
  EXAM_PAGE,
  OPEN_EXAM,
  OPEN_MS,
  OPEN_WORK,
  PAGE_WAIT_MS,
  WORK_NAME,
  WORK_SOURCE_ATTR,
  WORK_TRANSITION_CSS,
  WORK_VT_ATTR,
  cardArrival,
  cardRevealPending,
  closeCardPage,
  closeWork,
  hasViewTransitions,
  insetFor,
  leaveCardPage,
  openCardLink,
  openCardPage,
  openWork,
  playArrival,
  pageFetched,
  prefetchOnPress,
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

describe("circleFor", () => {
  const frame = { left: 240, top: 0, width: 1040, height: 800 };

  it("starts as the stop's own circle, about its centre in the frame", () => {
    const stop = { left: 300, top: 180, width: 56, height: 56 };
    // Centre (328, 208) less the frame's corner (240, 0); the farthest corner is (1040, 800) away by (952, 592).
    expect(circleFor(stop, frame)).toEqual({
      from: "circle(28px at 88px 208px)",
      to: `circle(${Math.ceil(Math.hypot(952, 592))}px at 88px 208px)`,
    });
  });

  it("covers the whole frame from a stop near its bottom right corner too", () => {
    const stop = { left: 1200, top: 700, width: 40, height: 40 };
    const c = circleFor(stop, frame);
    expect(c.from).toBe("circle(20px at 980px 720px)");
    expect(c.to).toBe(`circle(${Math.ceil(Math.hypot(980, 720))}px at 980px 720px)`);
  });
});

describe("the lecture page (M9-18)", () => {
  it("grows as a circle for 420 ms and shrinks back for 380 ms, under its own types", () => {
    expect(LECTURE_OPEN_MS).toBe(420);
    expect(LECTURE_CLOSE_MS).toBe(380);
    expect(LECTURE_PAGE).toEqual({
      open: OPEN_LECTURE,
      close: CLOSE_LECTURE,
      closeSlide: "close-lecture-slide",
      openMs: 420,
      shape: "circle",
    });
    expect(WORK_TRANSITION_CSS).toMatch(
      new RegExp(`\\[${WORK_VT_ATTR}="${OPEN_LECTURE}"\\]::view-transition-new\\(${WORK_NAME}\\) \\{\\s*animation: 420ms[^;]*ready-circle-open`),
    );
    expect(WORK_TRANSITION_CSS).toMatch(
      new RegExp(
        `\\[${WORK_VT_ATTR}="${CLOSE_LECTURE}"\\]::view-transition-old\\(${WORK_NAME}\\) \\{\\s*z-index: 1;\\s*animation: 380ms[^;]*ready-circle-close`,
      ),
    );
    expect(WORK_TRANSITION_CSS).toContain("var(--work-clip-full");
  });

  it("leaves the exam page's types and timings as they were", () => {
    expect(EXAM_PAGE.shape).toBeUndefined();
    expect(WORK_TRANSITION_CSS).toContain(`[${WORK_VT_ATTR}="${OPEN_EXAM}"]::view-transition-new(${WORK_NAME}) {\n  animation: 360ms`);
  });

  it("has nothing to hand a page that was not reached by a close", async () => {
    window.history.replaceState(null, "", "/courses/nowhere");
    expect(await cardClosed()).toBeNull();
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

describe("the wait for the new page is capped (M8-71)", () => {
  /**
   * A stand-in for document.startViewTransition: runs the update step and
   * reports what happened. As in the browser, a skip before the update step
   * has returned means no picture of the new state is taken and `ready`
   * rejects; the screen is live again from the skip on.
   */
  type Run = {
    updateDone: boolean;
    skipped: boolean;
    /** Skipped while the update step was still running: the screen was held no longer. */
    skippedInUpdate: boolean;
    ready: Promise<void>;
    finished: Promise<void>;
  };
  let runs: Run[] = [];

  /** Next has prefetched these paths (the route tree and the page: two `_rsc` requests each); none when empty. */
  function fetched(...paths: string[]) {
    const entries = paths.flatMap((p) => [
      { name: `${window.location.origin}${p}?_rsc=tree` },
      { name: `${window.location.origin}${p}?_rsc=page` },
    ]);
    (performance as unknown as { getEntriesByType: (t: string) => unknown[] }).getEntriesByType = (t) =>
      t === "resource" ? entries : [];
  }

  beforeEach(() => {
    vi.useFakeTimers();
    runs = [];
    (document as unknown as { startViewTransition: unknown }).startViewTransition = (update: () => Promise<void> | void) => {
      const run = { updateDone: false, skipped: false, skippedInUpdate: false } as Run;
      const done = Promise.resolve().then(update).then(() => {
        run.updateDone = true;
      });
      run.ready = done.then(() => {
        if (run.skippedInUpdate) throw new DOMException("Skipped", "AbortError");
      });
      run.ready.catch(() => {});
      // The animations take a while; skipping ends them at once.
      run.finished = done.then(() => new Promise((r) => setTimeout(r, run.skipped ? 0 : 400)));
      runs.push(run);
      return {
        ready: run.ready,
        finished: run.finished,
        skipTransition: () => {
          run.skipped = true;
          if (!run.updateDone) run.skippedInUpdate = true;
        },
      };
    };
  });

  afterEach(async () => {
    // Let the last transition end, so the next test is not refused as busy.
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    document.documentElement.removeAttribute(WORK_VT_ATTR);
    fetched();
  });

  /** Lets promises run, then moves the clock on by `ms`. */
  async function tick(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
  }

  /** Home with one card, its box measurable. */
  function home(key: string) {
    document.body.innerHTML = `<main id="main"><article ${WORK_SOURCE_ATTR}="${key}"><a href="${key}">Start</a></article></main>`;
    const main = document.getElementById("main")!;
    const card = main.querySelector("article")! as HTMLElement;
    card.getBoundingClientRect = () => ({ left: 20, top: 100, width: 300, height: 200 }) as DOMRect;
    return { main, card, link: card.querySelector("a")! };
  }

  function click(link: Element) {
    const e = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      currentTarget: link,
      preventDefault: () => {
        e.defaultPrevented = true;
      },
      stopPropagation: () => {},
    };
    return e as unknown as Parameters<typeof openWork>[0];
  }

  /** A page root that records the animations played on it. */
  function page(main: HTMLElement, id: string) {
    main.innerHTML = `<div id="${id}"><a href="/home">Back</a></div>`;
    const root = document.getElementById(id)!;
    const played: Keyframe[][] = [];
    root.animate = ((frames: Keyframe[]) => {
      played.push(frames);
      return { finished: Promise.resolve(), cancel: () => {} };
    }) as unknown as HTMLElement["animate"];
    return { root, played };
  }

  it("is short: a prefetched page commits inside it, and the held screen stays under 120 ms", () => {
    expect(PAGE_WAIT_MS).toBeGreaterThanOrEqual(30);
    // About 40 ms of taking the old picture comes on top.
    expect(PAGE_WAIT_MS).toBeLessThanOrEqual(70);
  });

  it("grows the exam page out of its card when it arrives in time", async () => {
    const { main, card } = home("card-a");
    openCardPage(card, "full", () => {});
    expect(document.documentElement.getAttribute(WORK_VT_ATTR)).toBe(OPEN_EXAM);
    await tick(PAGE_WAIT_MS / 3);
    // The first commit: the card is gone.
    const { root } = page(main, "exam");
    await tick(0);
    expect(runs[0].updateDone).toBe(true);
    expect(runs[0].skipped).toBe(false);
    expect(cardRevealPending()).toBe(true);
    expect(cardArrival(root)).toBeGreaterThan(0);
  });

  it("stops waiting for a late exam page at the cap, skips the clip and slides it in", async () => {
    const { main, card } = home("card-b");
    let went = 0;
    openCardPage(card, "full", () => went++);
    await tick(PAGE_WAIT_MS - 1);
    expect(went).toBe(1);
    expect(runs[0].updateDone).toBe(false);
    await tick(1);
    expect(runs[0].updateDone).toBe(true);
    expect(runs[0].skippedInUpdate).toBe(true);
    expect(cardRevealPending()).toBe(false);
    // The page lands a second later and slides in, with nothing left to wait for.
    await tick(1000);
    const { root, played } = page(main, "exam");
    expect(cardArrival(root)).toBe(0);
    expect(played).toEqual([[{ transform: "translateX(100%)" }, { transform: "none" }]]);
  });

  it("grows the workspace out of Start's card when its page was prefetched and commits in time", async () => {
    fetched("/assignments/a0");
    const { main, link } = home("/assignments/a0");
    window.history.replaceState(null, "", "/home");
    const e = click(link);
    openWork(e, "full");
    expect(e.defaultPrevented).toBe(true);
    expect(document.documentElement.getAttribute(WORK_VT_ATTR)).toBe(OPEN_WORK);
    await tick(PAGE_WAIT_MS / 3);
    main.innerHTML = "";
    await tick(0);
    expect(runs[0].updateDone).toBe(true);
    expect(runs[0].skipped).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--work-clip")).toContain("inset(");
  });

  it("starts no transition at all for a Start whose page is not fetched yet: the link navigates, the workspace slides in", async () => {
    const { main, link } = home("/assignments/a3");
    window.history.replaceState(null, "", "/home");
    const e = click(link);
    openWork(e, "full");
    // Nothing holds the screen: the click goes on to <Link> as usual.
    expect(e.defaultPrevented).toBe(false);
    expect(runs).toEqual([]);
    expect(document.documentElement.hasAttribute(WORK_VT_ATTR)).toBe(false);
    window.history.replaceState(null, "", "/assignments/a3");
    const { root, played } = page(main, "work");
    playArrival(root);
    expect(played).toEqual([[{ transform: "translateX(100%)" }, { transform: "none" }]]);
  });

  it("the same for a card link whose page is not fetched yet", async () => {
    document.body.innerHTML = `<main id="main"><a ${WORK_SOURCE_ATTR}="/exams/e4" href="/exams/e4">Exam</a></main>`;
    const main = document.getElementById("main")!;
    const card = main.querySelector("a")!;
    card.getBoundingClientRect = () => ({ left: 20, top: 100, width: 300, height: 200 }) as DOMRect;
    const e = click(card);
    openCardLink(e, "full");
    expect(runs).toEqual([]);
    expect(document.documentElement.hasAttribute(WORK_VT_ATTR)).toBe(false);
    const { root, played } = page(main, "exam");
    expect(cardArrival(root)).toBe(0);
    expect(played).toEqual([[{ transform: "translateX(100%)" }, { transform: "none" }]]);
  });

  it("does the same for the workspace that opens from Start", async () => {
    fetched("/assignments/a1");
    const { main, link } = home("/assignments/a1");
    window.history.replaceState(null, "", "/home");
    const e = click(link);
    openWork(e, "full");
    expect(e.defaultPrevented).toBe(true);
    await tick(PAGE_WAIT_MS);
    expect(runs[0].updateDone).toBe(true);
    expect(runs[0].skippedInUpdate).toBe(true);
    window.history.replaceState(null, "", "/assignments/a1");
    const { root, played } = page(main, "work");
    playArrival(root);
    expect(played).toEqual([[{ transform: "translateX(100%)" }, { transform: "none" }]]);
  });

  it("caps the close too: a late card page skips the shrink and the page slides out", async () => {
    document.body.innerHTML = `<main id="main"></main>`;
    const main = document.getElementById("main")!;
    window.history.replaceState(null, "", "/exams/e9");
    const { root, played } = page(main, "exam");
    const back = root.querySelector("a")!;
    const went: string[] = [];
    closeCardPage(click(back), back, "full", root, (path) => went.push(path), "/exams");
    expect(document.documentElement.getAttribute(WORK_VT_ATTR)).toBe(CLOSE_EXAM);
    await tick(PAGE_WAIT_MS - 1);
    expect(went).toEqual(["/exams"]);
    expect(runs[0].updateDone).toBe(false);
    await tick(1);
    expect(runs[0].updateDone).toBe(true);
    expect(runs[0].skippedInUpdate).toBe(true);
    expect(played).toEqual([[{ transform: "translateX(0%)" }, { transform: "translateX(100%)" }]]);
  });

  it("after a late close, puts the scroll and focus back once the card's page is there, not before", async () => {
    // Opened from a card on a scrolled Exams page.
    const { main, card } = home("card-late");
    window.history.replaceState(null, "", "/exams");
    main.scrollTop = 300;
    openCardPage(card, "full", () => window.history.replaceState(null, "", "/exams/e11"));
    const { root: exam } = page(main, "exam");
    await tick(0);
    cardArrival(exam);
    await vi.runAllTimersAsync();
    main.scrollTop = 40;
    const back = exam.querySelector("a")!;
    back.focus();
    closeCardPage(click(back), back, "full", exam, () => {}, "/exams");
    await tick(PAGE_WAIT_MS);
    expect(runs[1].skippedInUpdate).toBe(true);
    // The exam page is still there and slides out: its own scroll is left alone.
    expect(main.scrollTop).toBe(40);
    await tick(500);
    main.innerHTML = `<article ${WORK_SOURCE_ATTR}="card-late"><button>Exam</button></article>`;
    await tick(0);
    expect(main.scrollTop).toBe(300);
    expect(document.activeElement).toBe(main.querySelector("button"));
  });

  it("caps the workspace's close the same way", async () => {
    document.body.innerHTML = `<main id="main"></main>`;
    const main = document.getElementById("main")!;
    window.history.replaceState(null, "", "/assignments/a2");
    const { root, played } = page(main, "work");
    closeWork(click(root.querySelector("a")!) as Parameters<typeof closeWork>[0], "full", root);
    await tick(PAGE_WAIT_MS);
    expect(runs[0].updateDone).toBe(true);
    expect(runs[0].skippedInUpdate).toBe(true);
    expect(played).toEqual([[{ transform: "translateX(0%)" }, { transform: "translateX(100%)" }]]);
  });

  it("still shrinks into the card when it is back in time", async () => {
    document.body.innerHTML = `<main id="main"></main>`;
    const main = document.getElementById("main")!;
    window.history.replaceState(null, "", "/exams/e10");
    const { root, played } = page(main, "exam");
    const back = root.querySelector("a")!;
    closeCardPage(click(back), back, "full", root, () => {
      main.innerHTML = `<article ${WORK_SOURCE_ATTR}="/exams/e10"></article>`;
      const card = main.querySelector("article")!;
      card.getBoundingClientRect = () => ({ left: 20, top: 100, width: 300, height: 200 }) as DOMRect;
    }, "/exams");
    await tick(0);
    expect(runs[0].updateDone).toBe(true);
    expect(runs[0].skipped).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--work-clip")).toContain("inset(");
    expect(played).toEqual([]);
  });

  /** A course path with one stop, its box measurable; the lecture page opens from it. */
  function path(key: string) {
    document.body.innerHTML = `<main id="main"><div class="cpath"><button ${WORK_SOURCE_ATTR}="${key}">3</button></div></main>`;
    const main = document.getElementById("main")!;
    main.getBoundingClientRect = () => ({ left: 240, top: 0, width: 1040, height: 800 }) as DOMRect;
    const stop = main.querySelector("button")! as HTMLElement;
    stop.getBoundingClientRect = () => ({ left: 300, top: 180, width: 56, height: 56 }) as DOMRect;
    return { main, stop };
  }

  it("grows the lecture page out of its stop as a circle when it arrives in time", async () => {
    const { main, stop } = path("/courses/c1/lectures/3");
    const html = document.documentElement;
    openCardPage(stop, "full", () => {}, LECTURE_PAGE);
    expect(html.getAttribute(WORK_VT_ATTR)).toBe(OPEN_LECTURE);
    page(main, "lecture");
    await tick(0);
    expect(runs[0].skipped).toBe(false);
    expect(html.style.getPropertyValue("--work-clip")).toBe("circle(28px at 88px 208px)");
    expect(html.style.getPropertyValue("--work-clip-full")).toMatch(/^circle\(\d+px at 88px 208px\)$/);
    await tick(500);
    // Over: nothing is left on <html>.
    expect(html.hasAttribute(WORK_VT_ATTR)).toBe(false);
    expect(html.style.getPropertyValue("--work-clip-full")).toBe("");
  });

  it("opens a row's lecture out of the numbered circle inside the row's link", async () => {
    document.body.innerHTML = `<main id="main"><a href="/courses/c1/lectures/4?from=exam:e1"><span ${WORK_SOURCE_ATTR}="/courses/c1/lectures/4">4</span> Lecture 4</a></main>`;
    const main = document.getElementById("main")!;
    const link = main.querySelector("a")!;
    const num = main.querySelector("span")! as HTMLElement;
    num.getBoundingClientRect = () => ({ left: 20, top: 100, width: 44, height: 44 }) as DOMRect;
    fetched("/courses/c1/lectures/4");
    let followed = 0;
    link.addEventListener("click", () => followed++);
    const e = click(link) as unknown as Parameters<typeof openCardLink>[0] & { defaultPrevented: boolean };
    openCardLink(e, "full", LECTURE_PAGE);
    expect(e.defaultPrevented).toBe(true);
    expect(document.documentElement.getAttribute(WORK_VT_ATTR)).toBe(OPEN_LECTURE);
    await tick(0);
    // The link is followed inside the transition.
    expect(followed).toBe(1);
  });

  it("shrinks the lecture into its stop, and only then hands the course page what the lecture left", async () => {
    const { main, stop } = path("/courses/c1/lectures/3");
    window.history.replaceState(null, "", "/courses/c1");
    openCardPage(stop, "full", () => window.history.replaceState(null, "", "/courses/c1/lectures/3"), LECTURE_PAGE);
    const { root } = page(main, "lecture");
    await tick(0);
    cardArrival(root);
    await vi.runAllTimersAsync();

    const back = root.querySelector("a")!;
    let over: unknown = "not yet";
    closeCardPage(
      click(back),
      back,
      "full",
      root,
      (to) => {
        window.history.replaceState(null, "", to);
        main.innerHTML = `<div class="cpath"><button ${WORK_SOURCE_ATTR}="/courses/c1/lectures/3">3</button></div>`;
        main.querySelector("button")!.getBoundingClientRect = () => ({ left: 300, top: 180, width: 56, height: 56 }) as DOMRect;
        // The course page mounts and asks.
        void cardClosed().then((c) => (over = c?.detail));
      },
      "/courses/c1",
      LECTURE_PAGE,
      { lectureRead: 3 },
    );
    const html = document.documentElement;
    expect(html.getAttribute(WORK_VT_ATTR)).toBe(CLOSE_LECTURE);
    await tick(0);
    expect(runs[1].skipped).toBe(false);
    expect(html.style.getPropertyValue("--work-clip")).toBe("circle(28px at 88px 208px)");
    expect(html.style.getPropertyValue("--work-clip-full")).toMatch(/^circle\(\d+px at 88px 208px\)$/);
    // Still shrinking: the course page waits.
    await tick(LECTURE_CLOSE_MS - 100);
    expect(over).toBe("not yet");
    await tick(200);
    expect(over).toEqual({ lectureRead: 3 });
    expect(document.activeElement).toBe(document.querySelector("button"));
  });

  it("after a late close, hands it over once the page has slid out and the stop is back", async () => {
    document.body.innerHTML = `<main id="main"></main>`;
    const main = document.getElementById("main")!;
    window.history.replaceState(null, "", "/courses/c2/lectures/1");
    const { root } = page(main, "lecture");
    const back = root.querySelector("a")!;
    closeCardPage(click(back), back, "full", root, (to) => window.history.replaceState(null, "", to), "/courses/c2", LECTURE_PAGE, {
      lectureRead: 1,
    });
    let over: unknown = "not yet";
    void cardClosed("/courses/c2").then((c) => (over = c?.detail));
    await tick(PAGE_WAIT_MS);
    expect(runs[0].skippedInUpdate).toBe(true);
    await tick(400);
    expect(over).toBe("not yet");
    main.innerHTML = `<button ${WORK_SOURCE_ATTR}="/courses/c2/lectures/1">1</button>`;
    await tick(0);
    expect(over).toEqual({ lectureRead: 1 });
  });

  it("hands it over under the test switch and when calm too, once the stop's page is there", async () => {
    for (const mode of ["instant", "calm"] as const) {
      document.body.innerHTML = `<main id="main"></main>`;
      const main = document.getElementById("main")!;
      window.history.replaceState(null, "", "/courses/c3/lectures/2");
      const { root } = page(main, "lecture");
      const back = root.querySelector("a")!;
      closeCardPage(click(back), back, mode, root, () => {}, "/courses/c3", LECTURE_PAGE, { lectureRead: 2 });
      let over: unknown = "not yet";
      void cardClosed("/courses/c3").then((c) => (over = c?.detail));
      await tick(50);
      main.innerHTML = `<button ${WORK_SOURCE_ATTR}="/courses/c3/lectures/2">2</button>`;
      await tick(0);
      expect(over).toEqual({ lectureRead: 2 });
      // A moment later it is used up: a visit by some other way gets nothing.
      await tick(1500);
      expect(await cardClosed("/courses/c3")).toBeNull();
    }
  });
});

describe("prefetchOnPress", () => {
  it("prefetches the page when the card is pressed", () => {
    const prefetch = vi.fn();
    const { onPointerDown } = prefetchOnPress("/exams/e1", prefetch);
    onPointerDown({ button: 0, isPrimary: true } as Parameters<typeof onPointerDown>[0]);
    expect(prefetch).toHaveBeenCalledWith("/exams/e1");
  });

  it("ignores a second finger and other buttons", () => {
    const prefetch = vi.fn();
    const { onPointerDown } = prefetchOnPress("/exams/e1", prefetch);
    onPointerDown({ button: 2, isPrimary: true } as Parameters<typeof onPointerDown>[0]);
    onPointerDown({ button: 0, isPrimary: false } as Parameters<typeof onPointerDown>[0]);
    expect(prefetch).not.toHaveBeenCalled();
  });
});

describe("pageFetched", () => {
  afterEach(() => {
    delete (performance as unknown as { getEntriesByType?: unknown }).getEntriesByType;
  });

  function list(...names: string[]) {
    (performance as unknown as { getEntriesByType: (t: string) => unknown[] }).getEntriesByType = (t) =>
      t === "resource" ? names.map((name) => ({ name })) : [];
  }

  it("is true once both of <Link>'s prefetch requests for the page are back", () => {
    const o = window.location.origin;
    list(`${o}/assignments/x?_rsc=a`);
    expect(pageFetched("/assignments/x")).toBe(false);
    list(`${o}/assignments/x?_rsc=a`, `${o}/assignments/x?_rsc=b`);
    expect(pageFetched("/assignments/x")).toBe(true);
    expect(pageFetched(`${o}/assignments/x`)).toBe(true);
  });

  it("counts only the router's requests for that very page", () => {
    const o = window.location.origin;
    list(`${o}/assignments/x`, `${o}/assignments/x.css`, `${o}/assignments/xy?_rsc=a`, `${o}/assignments/xy?_rsc=b`);
    expect(pageFetched("/assignments/x")).toBe(false);
  });

  it("is false where there is no resource timing to ask", () => {
    expect(pageFetched("/assignments/x")).toBe(false);
  });
});

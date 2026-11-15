import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AfterOnly,
  BeforeOnly,
  GREET_AFTER_MS,
  HandedIn,
  HandedInGreeting,
  HOLD_MS,
  OUT_MS,
  QueueNumber,
  SETTLE_MS,
  Slide,
  Swap,
} from "./handed-in";

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("reduce") ? reduce : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

const BEFORE = "Hi Valeria. Assignment 3 is due tonight.";
const AFTER = "Handed in, 5 hours early. Next up is the memo.";

// The played hand-in is also kept in a module variable, so every test hands in a new one.
let handIn = 0;
let id = "";

function Home({ play, id: given = id }: { play: boolean; id?: string }) {
  return (
    <HandedIn play={play} id={given}>
      <HandedInGreeting sentence={AFTER} />
      <Slide as="section" aria-labelledby="first">
        <h2 id="first">DO FIRST</h2>
        <Swap before={<article>Assignment 3</article>} done={<p>Assignment 3 handed in</p>}>
          <article>Case memo 2</article>
        </Swap>
      </Slide>
      <Slide as="section" data-arrive-part="">
        <BeforeOnly>
          <p>Case memo 2, still in the list</p>
        </BeforeOnly>
        <AfterOnly>
          <p>Nothing else is open.</p>
        </AfterOnly>
        <span data-testid="num">
          <QueueNumber n={2} />
        </span>
      </Slide>
    </HandedIn>
  );
}

const num = () => screen.getByTestId("num").textContent;
const greeting = () => screen.getByTestId("greeting-bubble").querySelector(".sr-only")?.textContent;

function expectAfter() {
  expect(screen.queryByText("Assignment 3")).toBeNull();
  expect(screen.getByText("Assignment 3 handed in")).toBeTruthy();
  expect(screen.getByText("Case memo 2")).toBeTruthy();
  expect(screen.queryByText("Case memo 2, still in the list")).toBeNull();
  expect(screen.getByText("Nothing else is open.")).toBeTruthy();
}

describe("HandedIn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    id = `a3:${++handIn}`;
    // jsdom has no Web Animations; the calm mascot asks for its running ones.
    Element.prototype.getAnimations ??= () => [];
    window.sessionStorage.clear();
    window.sessionStorage.setItem("ready.greeting.typed", BEFORE);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.fast;
  });

  it("without play: the after state as plain markup", () => {
    const { container } = render(<Home play={false} />);
    expectAfter();
    expect(num()).toBe("2");
    expect(greeting()).toBe(AFTER);
    expect(container.querySelector("[data-handed-in]")).toBeNull();
    // The marks for Arrive pass through.
    expect(container.querySelectorAll("section[data-arrive-part]")).toHaveLength(1);
  });

  it("with play: the before state first, then the swap, then the greeting", () => {
    const { container } = render(<Home play />);
    // Before: the handed-in card is still Do first, the next one a row, numbers one higher.
    expect(screen.getByText("Assignment 3")).toBeTruthy();
    expect(screen.queryByText("Assignment 3 handed in")).toBeNull();
    expect(screen.queryByText("Case memo 2")).toBeNull();
    expect(screen.getByText("Case memo 2, still in the list")).toBeTruthy();
    expect(screen.queryByText("Nothing else is open.")).toBeNull();
    expect(num()).toBe("3");
    expect(greeting()).toBe(BEFORE);
    expect(container.querySelector('[data-handed-in="before"]')?.hasAttribute("inert")).toBe(true);

    // The card leaves; nothing has swapped yet.
    act(() => void vi.advanceTimersByTime(HOLD_MS + OUT_MS - 1));
    expect(screen.getByText("Assignment 3")).toBeTruthy();
    expect(window.sessionStorage.getItem("ready.handedIn.played")).toBeNull();

    // The swap: done row, the next item in Do first, the number rolls to 2.
    act(() => void vi.advanceTimersByTime(1));
    expectAfter();
    expect(screen.getByTestId("num").querySelector(".sr-only")?.textContent).toBe("2");
    expect(greeting()).toBe(BEFORE);
    expect(window.sessionStorage.getItem("ready.handedIn.played")).toBe(id);

    // Then the greeting says the handed-in sentence.
    act(() => void vi.advanceTimersByTime(GREET_AFTER_MS));
    expect(greeting()).toBe(AFTER);
  });

  it("plays once: a second visit with the same hand-in is at rest", () => {
    const first = render(<Home play />);
    act(() => void vi.advanceTimersByTime(HOLD_MS + OUT_MS + SETTLE_MS));
    first.unmount();

    render(<Home play />);
    expectAfter();
    expect(num()).toBe("2");
    expect(greeting()).toBe(AFTER);
  });

  it("a new hand-in plays again", () => {
    const first = render(<Home play />);
    act(() => void vi.advanceTimersByTime(HOLD_MS + OUT_MS + SETTLE_MS));
    first.unmount();

    render(<Home play id="memo:2" />);
    expect(screen.getByText("Assignment 3")).toBeTruthy();
    expect(num()).toBe("3");
  });

  it("left before the swap: it starts again from the before state", () => {
    const first = render(<Home play />);
    act(() => void vi.advanceTimersByTime(HOLD_MS));
    first.unmount();

    render(<Home play />);
    expect(screen.getByText("Assignment 3")).toBeTruthy();
  });

  it("reduced motion: the after state straight away, fading in", () => {
    stubReducedMotion(true);
    const { container } = render(<Home play />);
    expectAfter();
    expect(num()).toBe("2");
    expect(greeting()).toBe(AFTER);
    expect(container.querySelector('[data-handed-in="before"]')).toBeNull();
    expect(container.querySelector('[data-handed-in="done"]')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(200));
    expect(window.sessionStorage.getItem("ready.handedIn.played")).toBe(id);
  });

  it("the test switch: the after state at rest", () => {
    document.documentElement.dataset.fast = "1";
    render(<Home play />);
    expectAfter();
    expect(num()).toBe("2");
    expect(greeting()).toBe(AFTER);
  });
});

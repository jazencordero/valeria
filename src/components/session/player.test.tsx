import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => search,
  // As Next's: redirect throws, so nothing after it runs.
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));
vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));
// GET /study/new is tested below with its imports mocked.
vi.mock("@/server/study/actions", () => ({ beginSession: vi.fn() }));
vi.mock("@/server/study/store", () => {
  class StudyNotFound extends Error {}
  return { StudyNotFound };
});
vi.mock("@/server/auth/session", () => {
  class NotSignedIn extends Error {}
  return { NotSignedIn, currentUser: vi.fn(async () => ({ id: "user-1" })) };
});
// GET /study/new?lecture=: the real `safeReturn`, a stand-in for the session start.
vi.mock("@/server/study/lecture-session", async () => {
  const real = await vi.importActual<typeof import("@/server/study/lecture-session")>(
    "@/server/study/lecture-session",
  );
  return { safeReturn: real.safeReturn, beginLectureSession: vi.fn() };
});
vi.mock("@/server/db/client", () => ({ db: {} }));
vi.mock("@/server/db/schema/study", () => ({ SESSION_MODES: ["bite", "tile", "concept", "extra"] }));
vi.mock("@/components/ui/confetti", () => ({ burst: vi.fn() }));
// The card menu's Server Action; the player gets its own mock through props.
vi.mock("@/app/(app)/study/card-actions", () => ({ dropCard: vi.fn() }));

import type { NextRequest } from "next/server";
import { GET } from "@/app/(app)/study/new/route";
import { currentUser, NotSignedIn } from "@/server/auth/session";
import { beginLectureSession } from "@/server/study/lecture-session";
import { beginSession, type BegunSession, type DoneScreen, type SavedProgress } from "@/server/study/actions";
import { StudyNotFound } from "@/server/study/store";
import { initSession, step } from "@/lib/study/session";
import { optionSeed, shownOptions } from "@/lib/study/option-order";
import {
  LECTURE_BACK_LABEL,
  SAVE_FAILED_TEXT,
  SessionPlayer,
  returnLabel,
  safeReturnPath,
  exitOf,
  matchEvents,
  resumeSession,
  seedOf,
  toSessionCard,
  type PlayerCard,
  type SessionPlayerProps,
  type StoredReview,
} from "./player";

// Made-up sample content for tests only.
const T0 = Date.parse("2026-11-15T10:00:00Z");
const EXAM_AT = Date.parse("2026-11-23T07:00:00Z");
const SID = "5b1d2c3e-0000-4000-8000-000000000001";

const basic = (id: string, q: string, a: string, section: PlayerCard["section"] = "learn"): PlayerCard => ({
  id,
  type: "basic",
  boss: false,
  section,
  conceptIds: ["c1"],
  body: { q, a },
  why: null,
  source: "Lecture 1, slide 2",
  memory: null,
});

const A = basic("card-a", "What is a supplier audit?", "A check of a supplier against agreed terms.", "warm");
const B = basic("card-b", "What is single sourcing?", "Buying an item from one supplier on purpose.");
const C = basic("card-c", "What is a framework agreement?", "Terms agreed now for orders placed later.");
const MCQ: PlayerCard = {
  id: "card-m",
  type: "mcq",
  boss: false,
  section: "learn",
  conceptIds: ["c1"],
  body: {
    q: "Which one lowers supply risk most?",
    opts: [
      ["One supplier", false],
      ["Two qualified suppliers", true],
      ["Longer payment terms", false],
    ],
  },
  why: "A second source keeps parts coming when one fails.",
  source: "Lecture 3, slide 9",
  memory: null,
};

const MATCH: PlayerCard = {
  id: "card-p",
  type: "match",
  boss: false,
  section: "learn",
  conceptIds: ["c1"],
  body: {
    q: "Match each term to what it means.",
    pairs: [
      ["Single sourcing", "One supplier on purpose"],
      ["Dual sourcing", "Two suppliers for one item"],
      ["Framework", "Terms now, orders later"],
    ],
    order: [2, 0, 1],
  },
  why: null,
  source: "Lecture 2, slide 5",
  memory: null,
};

function doneScreen(over: Partial<DoneScreen> = {}): DoneScreen {
  return {
    sessionId: SID,
    examId: "exam-1",
    mode: "bite",
    planEnd: 88,
    planLead: "Keep a bite a day",
    stats: { cards: 3, reviews: 4, missed: 1, seconds: 95, best: 2, perfect: false },
    forecastBefore: 57.6,
    forecastAfter: 61.2,
    forecastBeforeShown: 58,
    forecastAfterShown: 61,
    moved: [{ id: "c1", name: "Supplier risk", from: 0.4, to: 0.5, rungFrom: 2, rungTo: 2 }],
    week: {
      days: [],
      count: 2,
      goal: 4,
      met: false,
      sentence: "2 of 4 days this week.",
      weeksInARow: 0,
      freeSkipsLeft: 1,
      streakLine: "",
    },
    bitesDoneToday: 1,
    bitesPerDay: 2,
    anotherBite: true,
    long: false,
    nextMinutes: null,
    left: null,
    leftLong: false,
    ...over,
  };
}

const saved: SavedProgress = { stored: 1, skipped: 0, due: [] };

function setup(over: Partial<SessionPlayerProps> = {}) {
  const saveProgress = vi.fn<SessionPlayerProps["saveProgress"]>().mockResolvedValue(saved);
  const endSession = vi.fn<SessionPlayerProps["endSession"]>().mockResolvedValue(doneScreen());
  let t = T0 + 60_000;
  const props: SessionPlayerProps = {
    sessionId: SID,
    examId: "exam-1",
    mode: "bite",
    examShort: "Purchasing",
    examAt: EXAM_AT,
    examDay: "Monday",
    targetPct: 80,
    startedAt: T0,
    cards: [A, B, C],
    concepts: { c1: { name: "Supplier risk", mastery: 0.4 } },
    reviews: [],
    gradeMode: "two",
    forecastBefore: 58,
    reviewedTodayBefore: false,
    saveProgress,
    endSession,
    retryMs: 0,
    now: () => (t += 1000),
    ...over,
  };
  const user = userEvent.setup();
  const view = render(<SessionPlayer {...props} />);
  return { ...view, user, props, saveProgress: props.saveProgress as typeof saveProgress, endSession: props.endSession as typeof endSession };
}

const cardOnScreen = () => screen.getByTestId("session-card").getAttribute("data-card-id");
const segments = () => screen.getByTestId("ss-prog").querySelectorAll("i");
const filled = () => screen.getByTestId("ss-prog").querySelectorAll("i[data-on]");

/** Shows the answer with Space, then grades with the key the two-button hint names. */
async function answer(user: ReturnType<typeof userEvent.setup>, key: "1" | "2") {
  await user.keyboard(" ");
  await screen.findByRole("group", { name: "How well did you remember?" });
  await user.keyboard(key);
}

beforeEach(() => {
  document.documentElement.dataset.fast = "1";
  push.mockReset();
  search = new URLSearchParams();
  if (!("getAnimations" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "getAnimations", { value: () => [], configurable: true });
  }
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
});

describe("SessionPlayer: a missed card", () => {
  it("comes back later in the bite, and progress grows a segment", async () => {
    const { user } = setup();
    expect(cardOnScreen()).toBe("card-a");
    expect(segments()).toHaveLength(3);

    await answer(user, "1"); // Missed
    expect(segments()).toHaveLength(4);
    expect(filled()).toHaveLength(1);
    expect(screen.getByTestId("ss-toast").textContent).toContain("Back in the pile");
    expect(cardOnScreen()).toBe("card-b");

    await answer(user, "2");
    expect(cardOnScreen()).toBe("card-c");
    await answer(user, "2");
    // Two cards on from the miss (the seeded coin), the missed card is back.
    expect(cardOnScreen()).toBe("card-a");
    expect(filled()).toHaveLength(3);
    expect(segments()).toHaveLength(4);
  });

  it("shows the hint the keys follow", async () => {
    const { user } = setup();
    expect(screen.getByText("Space to reveal · 1 or 2 to grade")).toBeTruthy();
    await user.keyboard(" ");
    expect(await screen.findByText("1 missed · 2 got it")).toBeTruthy();
  });

  it("plays a quiz card with 1-4 and Enter", async () => {
    const { user, saveProgress } = setup({ cards: [MCQ, B] });
    await user.keyboard("1"); // wrong
    expect(await screen.findByText("Not quite.")).toBeTruthy();
    expect(screen.getByText("Enter to continue")).toBeTruthy();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(saveProgress).toHaveBeenCalledTimes(1));
    expect(saveProgress.mock.calls[0][1]).toEqual([expect.objectContaining({ cardId: "card-m", grade: 1, firstTry: true })]);
    expect(cardOnScreen()).toBe("card-b");
    expect(segments()).toHaveLength(3);
  });
});

describe("SessionPlayer: a quiz card's option order", () => {
  const OPTS = (MCQ.body as { opts: [string, boolean][] }).opts;
  const shownTexts = () =>
    within(screen.getByTestId("session-card"))
      .getAllByRole("button")
      .map((b) => OPTS.find(([t]) => b.textContent?.includes(t))?.[0])
      .filter(Boolean);

  it("follows the shared seed for each attempt: a missed card comes back in its next attempt's order", async () => {
    const { user } = setup({ cards: [MCQ, B] });
    const card = () => screen.getByTestId("session-card");
    expect(card().getAttribute("data-attempt")).toBe("0");
    const first = shownOptions(OPTS, optionSeed("card-m", SID, 0)).map(([t]) => t);
    expect(shownTexts()).toEqual(first);
    // Miss it: press the key of a wrong option in the shown order.
    const wrong = first.findIndex((t) => !OPTS.find(([o]) => o === t)![1]);
    await user.keyboard(String(wrong + 1));
    expect(await screen.findByText("Not quite.")).toBeTruthy();
    // While it is on screen (feedback showing) the order and the attempt hold.
    expect(card().getAttribute("data-attempt")).toBe("0");
    expect(shownTexts()).toEqual(first);
    await user.keyboard("{Enter}");
    // Card B, then the missed card again, as its second attempt.
    await waitFor(() => expect(cardOnScreen()).toBe("card-b"));
    await user.keyboard(" ");
    await user.keyboard("2");
    await waitFor(() => expect(cardOnScreen()).toBe("card-m"));
    expect(card().getAttribute("data-attempt")).toBe("1");
    expect(shownTexts()).toEqual(shownOptions(OPTS, optionSeed("card-m", SID, 1)).map(([t]) => t));
  });
});

describe("SessionPlayer: the match card", () => {
  const term = (name: string) => within(screen.getByTestId("match-terms")).getByRole("button", { name });
  const meaning = (name: string) => within(screen.getByTestId("match-meanings")).getByRole("button", { name });

  it("is the real CardMatch: a clean run grades 3 and Enter goes on", async () => {
    const { user, saveProgress } = setup({ cards: [MATCH, B] });
    expect(screen.getByTestId("session-card").getAttribute("data-card-type")).toBe("match");
    expect(screen.getByTestId("card-match")).toBeTruthy();
    expect(screen.getByTestId("match-prompt").textContent).toBe("Tap a term, then what it means.");

    // As the whole-flow test plays it: focus a term, Enter, focus its meaning, Enter.
    for (const [t, m] of (MATCH.body as { pairs: [string, string][] }).pairs) {
      term(t).focus();
      await user.keyboard("{Enter}");
      meaning(m).focus();
      await user.keyboard("{Enter}");
    }
    expect(await screen.findByTestId("fb-strip")).toBeTruthy();
    // Enter on the last meaning matched it; it did not also go on.
    expect(cardOnScreen()).toBe("card-p");
    expect(saveProgress).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(saveProgress).toHaveBeenCalledTimes(1));
    expect(saveProgress.mock.calls[0][1]).toEqual([expect.objectContaining({ cardId: "card-p", grade: 3, firstTry: true })]);
    expect(cardOnScreen()).toBe("card-b");
  });

  it("counts a wrong pair as a slip: grade 2 and the slips line", async () => {
    const { user, saveProgress } = setup({ cards: [MATCH, B] });
    await user.click(term("Single sourcing"));
    await user.click(meaning("Two suppliers for one item")); // wrong
    expect(screen.getByTestId("card-match").getAttribute("data-slips")).toBe("1");
    await user.click(term("Single sourcing"));
    await user.click(meaning("One supplier on purpose"));
    await user.click(term("Dual sourcing"));
    await user.click(meaning("Two suppliers for one item"));
    await user.click(term("Framework"));
    await user.click(meaning("Terms now, orders later"));

    const strip = await screen.findByTestId("fb-strip");
    expect(strip.textContent).toContain("1 slip. Close enough to move on.");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(saveProgress).toHaveBeenCalledTimes(1));
    expect(saveProgress.mock.calls[0][1]).toEqual([expect.objectContaining({ cardId: "card-p", grade: 2 })]);
  });

  it("matchEvents brings the reducer to CardMatch's grade", () => {
    const cards = [toSessionCard(MATCH)];
    const run = (slips: number) =>
      matchEvents({ slips }, 3, T0).reduce(
        (s, e) => step(s, e),
        initSession({ cards, mode: "bite", seed: 1, at: T0, masteries: {} }),
      );
    expect(run(0)).toMatchObject({ phase: "fb", fbGrade: 3, fbSlips: 0 });
    expect(run(2)).toMatchObject({ phase: "fb", fbGrade: 2, fbSlips: 2 });
  });
});

describe("SessionPlayer: the stage", () => {
  it("holds the current card, with edges for the cards left", async () => {
    const { user } = setup();
    const stage = screen.getByTestId("ss-stage");
    expect(within(stage).getByTestId("session-card").getAttribute("data-card-id")).toBe("card-a");
    expect(stage.getAttribute("data-edges")).toBe("2");

    await answer(user, "2");
    expect(within(screen.getByTestId("ss-stage")).getByTestId("session-card").getAttribute("data-card-id")).toBe("card-b");
    expect(screen.getByTestId("ss-stage").getAttribute("data-edges")).toBe("1");
    // Only the card in place is the session card, even while the last one leaves.
    expect(screen.getAllByTestId("session-card")).toHaveLength(1);

    await answer(user, "2");
    expect(screen.getByTestId("ss-stage").getAttribute("data-edges")).toBe("0");
  });

  it("keeps a leaving card inert and without the session-card id (full motion)", async () => {
    delete document.documentElement.dataset.fast;
    const { user } = setup();
    await answer(user, "1"); // Missed: card-a sinks behind card-b
    const layers = document.querySelectorAll("[data-stage-key]");
    expect(layers).toHaveLength(2);
    expect(screen.getAllByTestId("session-card")).toHaveLength(1);
    expect(cardOnScreen()).toBe("card-b");
    expect(document.querySelector('[data-leaving] [data-card-id="card-a"]')).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll("[data-stage-key]")).toHaveLength(1));
  });

  it("leaves as the grade says", () => {
    expect(exitOf(1)).toBe("miss");
    expect(exitOf(2)).toBe("hard");
    expect(exitOf(3)).toBe("pass");
    expect(exitOf(4)).toBe("pass");
  });
});

describe("SessionPlayer: resume", () => {
  const stored = (cardId: string, grade: 1 | 3, i: number): StoredReview => ({
    cardId,
    grade,
    firstTry: true,
    ms: 4000,
    at: T0 + (i + 1) * 10_000,
  });

  it("lands on the first card not reviewed yet", () => {
    setup({ reviews: [stored("card-a", 3, 0), stored("card-b", 3, 1)] });
    expect(cardOnScreen()).toBe("card-c");
    expect(filled()).toHaveLength(2);
  });

  it("keeps a missed card in the place it went before the reload", async () => {
    const { user, saveProgress } = setup({ reviews: [stored("card-a", 1, 0)] });
    expect(cardOnScreen()).toBe("card-b");
    expect(segments()).toHaveLength(4);
    expect(filled()).toHaveLength(1);
    // Replayed reviews are already stored: nothing is sent again.
    expect(saveProgress).not.toHaveBeenCalled();

    await answer(user, "2");
    await answer(user, "2");
    expect(cardOnScreen()).toBe("card-a");
  });

  it("gives the same queue as playing it through (same seed)", () => {
    const cards = [A, B, C].map(toSessionCard);
    const seed = seedOf(SID);
    expect(seedOf(SID)).toBe(seed);
    const s = resumeSession({ cards, mode: "bite", seed, startedAt: T0, masteries: {}, reviews: [stored("card-a", 1, 0)], now: T0 });
    expect(s.queue).toEqual(["card-b", "card-c", "card-a"]);
    expect(s.passed).toBe(1);
  });

  it("goes to the done screen when every card was already reviewed", async () => {
    const { endSession } = setup({
      cards: [A],
      reviews: [stored("card-a", 3, 0)],
    });
    await screen.findByTestId("session-done");
    expect(endSession).toHaveBeenCalledWith(SID);
  });
});

describe("SessionPlayer: saving", () => {
  it("calls saveProgress after each card with that card's review", async () => {
    const { user, saveProgress } = setup();
    await answer(user, "2");
    await waitFor(() => expect(saveProgress).toHaveBeenCalledTimes(1));
    expect(saveProgress).toHaveBeenLastCalledWith(SID, [
      expect.objectContaining({ cardId: "card-a", grade: 3, firstTry: true, at: expect.any(Number) }),
    ]);
    await answer(user, "1");
    await waitFor(() => expect(saveProgress).toHaveBeenCalledTimes(2));
    expect(saveProgress.mock.calls[1][1]).toEqual([expect.objectContaining({ cardId: "card-b", grade: 1 })]);
  });

  it("retries a failed save quietly with the same batch", async () => {
    const saveProgress = vi
      .fn<SessionPlayerProps["saveProgress"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(saved);
    const { user } = setup({ saveProgress });
    await answer(user, "2");
    await waitFor(() => expect(saveProgress).toHaveBeenCalledTimes(3));
    const batches = saveProgress.mock.calls.map((c) => c[1]);
    expect(batches[1]).toEqual(batches[0]);
    expect(batches[2]).toEqual(batches[0]);
    expect(screen.queryByText(SAVE_FAILED_TEXT)).toBeNull();
  });

  it("shows a quiet line only when every retry failed, and sends the review with the next card", async () => {
    const saveProgress = vi.fn<SessionPlayerProps["saveProgress"]>().mockRejectedValue(new Error("offline"));
    const { user } = setup({ saveProgress });
    await answer(user, "2");
    expect(await screen.findByText(SAVE_FAILED_TEXT)).toBeTruthy();
    expect(saveProgress).toHaveBeenCalledTimes(4);

    saveProgress.mockReset();
    saveProgress.mockResolvedValue(saved);
    await answer(user, "2");
    await waitFor(() => expect(saveProgress).toHaveBeenCalledTimes(1));
    expect(saveProgress.mock.calls[0][1].map((r) => r.cardId)).toEqual(["card-a", "card-b"]);
    await waitFor(() => expect(screen.queryByText(SAVE_FAILED_TEXT)).toBeNull());
  });
});

describe("SessionPlayer: the end", () => {
  it("shows the done screen from endSession after the last card, once the saves are in", async () => {
    const { user, saveProgress, endSession } = setup({ cards: [A, B] });
    await answer(user, "2");
    await answer(user, "2");
    await screen.findByTestId("session-done");
    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(endSession.mock.invocationCallOrder[0]).toBeGreaterThan(saveProgress.mock.invocationCallOrder[1]);
    expect(screen.getByText(/PURCHASING · FORECAST/i)).toBeTruthy();
  });

  it("One more bite starts the next bite; Done for now goes back with the old forecast", async () => {
    const { user } = setup({ cards: [A] });
    await answer(user, "2");
    await screen.findByTestId("session-done");
    await user.click(screen.getByRole("button", { name: /One more bite · 2 min/ }));
    expect(push).toHaveBeenLastCalledWith("/study/new?exam=exam-1&kind=bite");
    await user.click(screen.getByRole("button", { name: "Done for now" }));
    expect(push).toHaveBeenLastCalledWith("/exams/exam-1?from=58");
  });

  it("Back to the exam returns with ?from= when today's plan is done", async () => {
    const endSession = vi.fn<SessionPlayerProps["endSession"]>().mockResolvedValue(doneScreen({ anotherBite: false }));
    const { user } = setup({ cards: [A], endSession });
    await answer(user, "2");
    await screen.findByTestId("session-done");
    expect(screen.queryByRole("button", { name: /One more bite/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back to the exam" }));
    expect(push).toHaveBeenLastCalledWith("/exams/exam-1?from=58");
  });

  it("keeps the way out pinned to the bottom of the done screen, so a phone never has to scroll to it", async () => {
    const { user } = setup({ cards: [A] });
    await answer(user, "2");
    await screen.findByTestId("session-done");
    const actions = screen.getByTestId("session-done-actions");
    expect(actions.className).toMatch(/\bsticky\b/);
    expect(actions.className).toMatch(/\bbottom-0\b/);
    expect(actions.contains(screen.getByRole("button", { name: "Done for now" }))).toBe(true);
  });

  it("Stop saves and goes back to the exam without ending the session", async () => {
    const { user, endSession, saveProgress } = setup();
    await answer(user, "2");
    await user.click(screen.getByRole("button", { name: "Stop session" }));
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Stop" }));
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/exams/exam-1?from=58"));
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(endSession).not.toHaveBeenCalled();
  });
});

describe("SessionPlayer: one go", () => {
  const left = { long: true, nextMinutes: 3, left: { minutes: 12, bites: 5 }, leftLong: true };

  it("Stop ends the session with what she did and the done screen says what is left", async () => {
    const endSession = vi.fn<SessionPlayerProps["endSession"]>().mockResolvedValue(doneScreen(left));
    const { user, saveProgress } = setup({ long: true, endSession });
    await answer(user, "2");
    await user.click(screen.getByRole("button", { name: "Stop session" }));
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Stop" }));
    });
    await screen.findByTestId("session-done");
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledWith(SID);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId("today-left").textContent).toBe("About 12 minutes of today\u2019s plan left");
    expect(screen.getByText("Session done.")).toBeTruthy();
    // The rest is offered in one go again.
    await user.click(screen.getByRole("button", { name: "Do them in one go" }));
    expect(push).toHaveBeenLastCalledWith("/study/new?exam=exam-1&kind=long");
  });

  it("stopped before the first grade it just goes back", async () => {
    const { user, endSession } = setup({ long: true });
    await user.click(screen.getByRole("button", { name: "Stop session" }));
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Stop" }));
    });
    await waitFor(() => expect(push).toHaveBeenLastCalledWith("/exams/exam-1?from=58"));
    expect(endSession).not.toHaveBeenCalled();
  });

  it("with three bites or fewer left it offers one more bite, with the next bite's own minutes", async () => {
    const endSession = vi
      .fn<SessionPlayerProps["endSession"]>()
      .mockResolvedValue(doneScreen({ ...left, left: { minutes: 6, bites: 2 }, leftLong: false }));
    const { user } = setup({ long: true, cards: [A], endSession });
    await answer(user, "2");
    await screen.findByTestId("session-done");
    expect(screen.getByTestId("today-left").textContent).toBe("About 6 minutes of today\u2019s plan left");
    await user.click(screen.getByRole("button", { name: /One more bite · 3 min/ }));
    expect(push).toHaveBeenLastCalledWith("/study/new?exam=exam-1&kind=bite");
  });

  it("an ordinary bite's done screen is as it was", async () => {
    const { user } = setup({ cards: [A] });
    await answer(user, "2");
    await screen.findByTestId("session-done");
    expect(screen.queryByTestId("today-left")).toBeNull();
    expect(screen.getByText("Bite done.")).toBeTruthy();
  });
});

describe("SessionPlayer: back to the lecture", () => {
  const LECTURE = "/courses/7c0e1a52-0000-4000-8000-0000000000cc/lectures/5";

  it("ends with 'Back to the lecture', which returns there, and offers no other bite", async () => {
    const { user } = setup({ cards: [A], mode: "concept", returnTo: LECTURE });
    await answer(user, "2");
    await screen.findByTestId("session-done");
    expect(screen.queryByRole("button", { name: /One more bite/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Done for now" })).toBeNull();
    await user.click(screen.getByRole("button", { name: LECTURE_BACK_LABEL }));
    expect(push).toHaveBeenLastCalledWith(LECTURE);
  });

  it("reads ?return= from the URL, and Stop goes back there too", async () => {
    search = new URLSearchParams({ return: LECTURE });
    const { user } = setup({ mode: "concept" });
    await answer(user, "2");
    await user.click(screen.getByRole("button", { name: "Stop session" }));
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Stop" }));
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith(LECTURE));
  });

  it("ignores a return that is not a path on this site", async () => {
    search = new URLSearchParams({ return: "//evil.example/x" });
    const { user } = setup({ cards: [A] });
    await answer(user, "2");
    await screen.findByTestId("session-done");
    await user.click(screen.getByRole("button", { name: "Done for now" }));
    expect(push).toHaveBeenLastCalledWith("/exams/exam-1?from=58");
  });

  it("safeReturnPath keeps same-site paths only", () => {
    expect(safeReturnPath(LECTURE)).toBe(LECTURE);
    expect(safeReturnPath("/exams/x?from=3")).toBe("/exams/x?from=3");
    for (const bad of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "evil.example/x",
      "",
      "/a b",
      "/a\nb",
      "/" + "a".repeat(600),
      null,
      42,
    ]) {
      expect(safeReturnPath(bad)).toBeNull();
    }
  });

  it("labels a lecture page 'Back to the lecture' and anything else 'Back'", () => {
    expect(returnLabel(LECTURE)).toBe("Back to the lecture");
    expect(returnLabel("/courses/abc")).toBe("Back");
  });
});

describe("GET /study/new", () => {
  const EXAM = "7c0e1a52-0000-4000-8000-0000000000aa";
  const begun = { sessionId: SID } as BegunSession;

  async function go(query: string): Promise<string> {
    const url = new URL(`http://localhost/study/new?${query}`);
    try {
      await GET({ nextUrl: url } as unknown as NextRequest);
    } catch (err) {
      const to = (err as { to?: string }).to;
      if (to) return to;
      throw err;
    }
    throw new Error("no redirect");
  }

  beforeEach(() => {
    vi.mocked(beginSession).mockReset();
    vi.mocked(beginSession).mockResolvedValue(begun);
  });

  it.each([
    ["kind=bite", "bite", undefined],
    ["kind=tile&arg=basic", "tile", "basic"],
    ["kind=concept&arg=c1", "concept", "c1"],
    ["kind=extra", "extra", undefined],
    ["kind=long", "long", undefined],
  ])("starts %s with beginSession and redirects to the session", async (q, kind, arg) => {
    expect(await go(`exam=${EXAM}&${q}`)).toBe(`/study/${SID}`);
    expect(beginSession).toHaveBeenCalledWith(EXAM, kind, arg);
  });

  it("sends bad input back to the exam page, or to /exams without a valid exam", async () => {
    expect(await go(`exam=${EXAM}&kind=nap`)).toBe(`/exams/${EXAM}`);
    expect(await go(`exam=${EXAM}&kind=tile`)).toBe(`/exams/${EXAM}`);
    expect(await go(`exam=${EXAM}&kind=concept`)).toBe(`/exams/${EXAM}`);
    expect(await go("exam=nope&kind=bite")).toBe("/exams");
    expect(await go("kind=bite")).toBe("/exams");
    expect(beginSession).not.toHaveBeenCalled();
  });

  it("goes back to the exam when there is nothing to study, and to /exams for someone else's exam", async () => {
    vi.mocked(beginSession).mockResolvedValueOnce(null);
    expect(await go(`exam=${EXAM}&kind=bite`)).toBe(`/exams/${EXAM}`);
    vi.mocked(beginSession).mockRejectedValueOnce(new Error("beginSession: unknown card type zz"));
    expect(await go(`exam=${EXAM}&kind=tile&arg=zz`)).toBe(`/exams/${EXAM}`);
    vi.mocked(beginSession).mockRejectedValueOnce(new StudyNotFound("exam", "x"));
    expect(await go(`exam=${EXAM}&kind=bite`)).toBe("/exams");
    vi.mocked(beginSession).mockRejectedValueOnce(new NotSignedIn());
    expect(await go(`exam=${EXAM}&kind=bite`)).toBe("/");
  });

  const LEC = "7c0e1a52-0000-4000-8000-0000000000bb";
  const LEC_PATH = "/courses/7c0e1a52-0000-4000-8000-0000000000cc/lectures/5";
  const ret = encodeURIComponent(LEC_PATH);

  it("starts a lecture session and passes the return on to the session", async () => {
    vi.mocked(beginLectureSession).mockReset();
    vi.mocked(beginLectureSession).mockResolvedValue({ sessionId: SID, examId: EXAM, cards: 3 });
    expect(await go(`lecture=${LEC}&return=${ret}`)).toBe(`/study/${SID}?return=${ret}`);
    expect(beginLectureSession).toHaveBeenCalledWith("user-1", LEC);
    expect(beginSession).not.toHaveBeenCalled();
  });

  it("goes back to the lecture when it has no cards, and to Courses without a valid return", async () => {
    vi.mocked(beginLectureSession).mockReset();
    vi.mocked(beginLectureSession).mockResolvedValue(null);
    expect(await go(`lecture=${LEC}&return=${ret}`)).toBe(LEC_PATH);
    expect(await go(`lecture=nope&return=${ret}`)).toBe(LEC_PATH);
    expect(await go(`lecture=${LEC}`)).toBe("/courses");
    expect(beginLectureSession).toHaveBeenCalledTimes(2);
  });

  it("drops a return that is not a same-site path", async () => {
    vi.mocked(beginLectureSession).mockReset();
    vi.mocked(beginLectureSession).mockResolvedValue({ sessionId: SID, examId: EXAM, cards: 3 });
    for (const bad of ["//evil.example", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)"]) {
      expect(await go(`lecture=${LEC}&return=${encodeURIComponent(bad)}`)).toBe(`/study/${SID}`);
    }
    vi.mocked(beginLectureSession).mockResolvedValue(null);
    expect(await go(`lecture=${LEC}&return=${encodeURIComponent("//evil.example")}`)).toBe("/courses");
  });

  it("passes a return through an exam session, and goes back there when there is nothing to study", async () => {
    expect(await go(`exam=${EXAM}&kind=bite&return=${ret}`)).toBe(`/study/${SID}?return=${ret}`);
    vi.mocked(beginSession).mockResolvedValueOnce(null);
    expect(await go(`exam=${EXAM}&kind=bite&return=${ret}`)).toBe(LEC_PATH);
  });

  it("sends a signed-out lecture start to /", async () => {
    vi.mocked(currentUser).mockRejectedValueOnce(new NotSignedIn());
    expect(await go(`lecture=${LEC}&return=${ret}`)).toBe("/");
  });
});

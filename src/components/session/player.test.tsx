import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
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
  return { NotSignedIn };
});
vi.mock("@/server/db/schema/study", () => ({ SESSION_MODES: ["bite", "tile", "concept", "extra"] }));
vi.mock("@/components/ui/confetti", () => ({ burst: vi.fn() }));
// The card menu's Server Action; the player gets its own mock through props.
vi.mock("@/app/(app)/study/card-actions", () => ({ dropCard: vi.fn() }));

import type { NextRequest } from "next/server";
import { GET } from "@/app/(app)/study/new/route";
import { NotSignedIn } from "@/server/auth/session";
import { beginSession, type BegunSession, type DoneScreen, type SavedProgress } from "@/server/study/actions";
import { StudyNotFound } from "@/server/study/store";
import {
  SAVE_FAILED_TEXT,
  SessionPlayer,
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

function doneScreen(over: Partial<DoneScreen> = {}): DoneScreen {
  return {
    sessionId: SID,
    examId: "exam-1",
    mode: "bite",
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
});

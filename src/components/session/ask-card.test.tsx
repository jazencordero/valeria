import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/ui/confetti", () => ({ burst: vi.fn() }));
vi.mock("@/app/(app)/study/card-actions", () => ({ dropCard: vi.fn() }));
vi.mock("@/app/(app)/notes/actions", () => ({ notepadContext: vi.fn(), saveNotepad: vi.fn() }));
vi.mock("@/app/(app)/notes/card-actions", () => ({ addCardsFromNote: vi.fn(), noteCardExams: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ showToast: vi.fn() }));

import type { NotepadActions } from "@/components/notes/notepad";
import { NotepadView } from "@/components/notes/notepad";
import type { SavedProgress, DoneScreen } from "@/server/study/actions";
import {
  ASK_CARD_TEXT,
  NOTEPAD_CARD_GONE_EVENT,
  NOTEPAD_OPEN_EVENT,
  askAboutCard,
  cardPassage,
  notepadOver,
} from "./ask-card";
import { STOP_TEXT } from "./frame";
import { SessionPlayer, type PlayerCard, type SessionPlayerProps } from "./player";

// Made-up sample content for tests only.
const T0 = Date.parse("2026-11-15T10:00:00Z");
const EXAM_AT = Date.parse("2026-11-23T07:00:00Z");
const SID = "5b1d2c3e-0000-4000-8000-000000000001";
const CARD_A = "6c2e3d4f-0000-4000-8000-00000000000a";
const CARD_B = "6c2e3d4f-0000-4000-8000-00000000000b";

const basic = (id: string, q: string, a: string): PlayerCard => ({
  id,
  type: "basic",
  boss: false,
  section: "learn",
  conceptIds: ["c1"],
  body: { q, a },
  why: null,
  source: null,
  memory: null,
});

const A = basic(CARD_A, "What is single sourcing?", "Buying an item from one supplier on purpose.");
const B = basic(CARD_B, "What is a framework agreement?", "Terms agreed now for orders placed later.");

const saved: SavedProgress = { stored: 1, skipped: 0, due: [] };

function playerProps(over: Partial<SessionPlayerProps> = {}): SessionPlayerProps {
  let t = T0 + 60_000;
  return {
    sessionId: SID,
    examId: "exam-1",
    mode: "bite",
    examShort: "Purchasing",
    examAt: EXAM_AT,
    examDay: "Monday",
    targetPct: 80,
    startedAt: T0,
    cards: [A, B],
    concepts: { c1: { name: "Supplier risk", mastery: 0.4 } },
    reviews: [],
    gradeMode: "two",
    forecastBefore: 58,
    reviewedTodayBefore: false,
    saveProgress: vi.fn().mockResolvedValue(saved),
    endSession: vi.fn().mockResolvedValue({} as DoneScreen),
    retryMs: 0,
    now: () => (t += 1000),
    ...over,
  };
}

function notepadActions(): NotepadActions {
  return {
    save: vi.fn(async (input) => ({ ok: true, id: input.id ?? "11111111-1111-4111-8111-111111111111" }) as never),
    context: vi.fn(async () => ({ ok: true, label: "Purchasing" }) as never),
    addCards: vi.fn(),
    exams: vi.fn(),
  };
}

function tutorApi() {
  const calls: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(b);
    if (b.mode === "load") return Response.json({ messages: [], deeperAvailable: false });
    const lines = [
      { type: "start", messageMetadata: { model: "groq:openai/gpt-oss-120b", answerId: CARD_A, questionId: "q", deeper: false } },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "One supplier, chosen on purpose." },
      { type: "text-end", id: "0" },
      { type: "finish" },
    ];
    return new Response(lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join(""), { status: 200 });
  });
  return { calls, api: { fetch: fetch as unknown as typeof globalThis.fetch, writeClipboard: vi.fn(async () => {}) } };
}

let wide = false;

beforeEach(() => {
  document.documentElement.dataset.fast = "1";
  wide = false;
  if (!("getAnimations" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "getAnimations", { value: () => [], configurable: true });
  }
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("min-width: 700px") ? wide : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
  localStorage.clear();
});

const cardOnScreen = () => screen.getByTestId("session-card").getAttribute("data-card-id");
const askButton = () => screen.queryByRole("button", { name: ASK_CARD_TEXT });

describe("cardPassage", () => {
  it("is the question and the answer she was shown, in plain text", () => {
    expect(cardPassage("basic", { q: "What is PV?", a: "Today's worth." })).toBe("What is PV?\n\nAnswer: Today's worth.");
    expect(cardPassage("cloze", { q: "PV is {{today's}} worth of {{future}} money." })).toBe(
      "PV is ____ worth of ____ money.\n\nAnswer: PV is today's worth of future money.",
    );
    expect(
      cardPassage("mcq", {
        q: "Which lowers risk?",
        opts: [
          ["One supplier", false],
          ["Two suppliers", true],
        ],
      }),
    ).toBe("Which lowers risk?\n\nAnswer: Two suppliers");
    expect(cardPassage("match", { q: "Match them.", pairs: [["Dual", "Two suppliers"]], order: [0] })).toBe("Match them.\n\nDual: Two suppliers");
    expect(cardPassage("explain", { q: "Explain NPV.", model: "Sum of discounted flows." })).toBe(
      "Explain NPV.\n\nModel answer: Sum of discounted flows.",
    );
    expect(cardPassage("basic", { q: "x".repeat(5000), a: "y" })).toHaveLength(4000);
  });
});

describe("SessionPlayer: Ask about this card", () => {
  it("without the switch there is no entry, before or after the answer", async () => {
    const user = userEvent.setup();
    render(<SessionPlayer {...playerProps()} />);
    expect(askButton()).toBeNull();
    await user.keyboard(" ");
    await screen.findByRole("group", { name: "How well did you remember?" });
    expect(askButton()).toBeNull();
  });

  it("with the switch: absent on the front, there once revealed, and it sends the card", async () => {
    const user = userEvent.setup();
    const opened: unknown[] = [];
    const listen = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener(NOTEPAD_OPEN_EVENT, listen);
    render(<SessionPlayer {...playerProps({ tutor: true })} />);
    expect(askButton()).toBeNull();
    await user.keyboard(" ");
    await screen.findByRole("group", { name: "How well did you remember?" });
    await user.click(askButton()!);
    window.removeEventListener(NOTEPAD_OPEN_EVENT, listen);
    expect(opened).toEqual([
      { quote: "What is single sourcing?\n\nAnswer: Buying an item from one supplier on purpose.", card: { id: CARD_A } },
    ]);
  });

  it("the next card tells the panel its card is gone", async () => {
    const user = userEvent.setup();
    let gone = 0;
    const listen = () => (gone += 1);
    render(<SessionPlayer {...playerProps({ tutor: true })} />);
    window.addEventListener(NOTEPAD_CARD_GONE_EVENT, listen);
    await user.keyboard(" ");
    await screen.findByRole("group", { name: "How well did you remember?" });
    const before = gone;
    await user.keyboard("2");
    expect(cardOnScreen()).toBe(CARD_B);
    expect(gone).toBeGreaterThan(before);
    window.removeEventListener(NOTEPAD_CARD_GONE_EVENT, listen);
  });
});

describe("The notes panel over a session (M2-28 follow-up)", () => {
  function both(tutor: boolean) {
    const { api, calls } = tutorApi();
    const user = userEvent.setup();
    const view = render(
      <>
        <SessionPlayer {...playerProps({ tutor })} />
        <NotepadView pathname={`/study/${SID}`} actions={notepadActions()} tutor={tutor} tutorApi={api} />
      </>,
    );
    return { ...view, user, calls };
  }

  it("opens over the session with the card as the quote and the card's chat; keys and Escape are the panel's", async () => {
    const { user, calls } = both(true);
    await user.keyboard(" ");
    await screen.findByRole("group", { name: "How well did you remember?" });
    await user.click(askButton()!);
    const pad = await screen.findByRole("dialog", { name: "Notepad" });
    expect(notepadOver()).toBe(true);
    expect(pad.className).toContain("over");
    // The session made everything else inert; the panel's layer is not.
    const layer = pad.closest("[data-notepad-layer]") as HTMLElement;
    expect(layer.inert).toBe(false);
    expect(layer.hasAttribute("aria-hidden")).toBe(false);
    expect(pad.querySelector(".np-quote")?.textContent).toBe(
      "What is single sourcing?\n\nAnswer: Buying an item from one supplier on purpose.",
    );
    // The card's own chat: loaded by place, with the starters for an empty one.
    expect(calls[0]).toEqual({ mode: "load", where: { kind: "study", sessionId: SID, cardId: CARD_A, revealed: true } });
    expect(screen.getByRole("button", { name: "Explain this simply" })).toBeTruthy();

    // Typing digits and spaces in the chat box grades nothing.
    const box = screen.getByTestId("tutor-box");
    await user.click(box);
    await user.keyboard("2 1 2");
    expect((box as HTMLTextAreaElement).value).toBe("2 1 2");
    expect(cardOnScreen()).toBe(CARD_A);
    // Nor do keys on the panel's buttons.
    screen.getByRole("button", { name: "Explain this simply" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "2" });
    expect(cardOnScreen()).toBe(CARD_A);

    // A question goes with the card's place and no quote (the server reads the card itself).
    await user.clear(box);
    await user.type(box, "Why on purpose?{Enter}");
    await screen.findByText("One supplier, chosen on purpose.");
    expect(calls[1]).toEqual({ text: "Why on purpose?", where: { kind: "study", sessionId: SID, cardId: CARD_A, revealed: true } });

    // Escape closes the panel only, not into the session's stop confirm.
    await user.keyboard("{Escape}");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.queryByRole("dialog", { name: "Notepad" })).toBeNull();
    expect(screen.queryByText(STOP_TEXT)).toBeNull();
    expect(notepadOver()).toBe(false);
    expect(cardOnScreen()).toBe(CARD_A);
  });

  it("the next card closes the panel (wide screen, where the session stays clickable)", async () => {
    wide = true;
    const { user } = both(true);
    await user.keyboard(" ");
    await screen.findByRole("group", { name: "How well did you remember?" });
    await user.click(askButton()!);
    await screen.findByRole("dialog", { name: "Notepad" });
    await user.click(screen.getByRole("button", { name: /Got it/ }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(cardOnScreen()).toBe(CARD_B);
    expect(screen.queryByRole("dialog", { name: "Notepad" })).toBeNull();
    expect(askButton()).toBeNull();
  });

  it("without the switch an ask event opens nothing in a session", async () => {
    both(false);
    act(() => askAboutCard(CARD_A, "What is single sourcing?"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.queryByRole("dialog", { name: "Notepad" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Notes, open the notepad" })).toBeNull();
  });
});

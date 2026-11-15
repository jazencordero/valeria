/**
 * M2-28 QA: where the tutor's chat scrolls, and when it tells the notepad she is chatting.
 * jsdom has no layout, so the log and its turns get a small layout model here: the log's top is
 * at 100 px and it shows 200 px; a question is 40 px tall, an answer 20 px per 40 characters, with
 * 12 px between turns and 4 px of padding above and 8 px below.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollTopFor, TutorChat, TutorChatView, type ChatTurn, type TutorApi, type TutorChatViewProps } from "./tutor-chat";

const LOG_TOP = 100;
const VIEW = 200;
const GAP = 12;
const PAD_TOP = 4;
const PAD_BOTTOM = 8;

const heightOf = (li: HTMLElement) =>
  li.dataset.testid === "tutor-mine" ? 40 : Math.max(20, 20 * Math.ceil((li.textContent ?? "").length / 40));

const isLog = (el: Element) => el instanceof HTMLElement && el.dataset.testid === "tutor-log";
const scrolls = new WeakMap<Element, number>();

/** Each turn's top inside the log's content, and the content's height. */
function layout(log: Element): { tops: Map<Element, number>; height: number } {
  const tops = new Map<Element, number>();
  let y = PAD_TOP;
  const items = Array.from(log.querySelectorAll<HTMLElement>("[data-turn]"));
  items.forEach((li, i) => {
    tops.set(li, y);
    y += heightOf(li) + (i < items.length - 1 ? GAP : 0);
  });
  return { tops, height: y + PAD_BOTTOM };
}

const maxScroll = (log: Element) => Math.max(0, layout(log).height - VIEW);

let restore: (() => void) | null = null;

beforeEach(() => {
  document.documentElement.dataset.fast = "1";
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
  const proto = HTMLElement.prototype;
  const rect = proto.getBoundingClientRect;
  const own = (name: "scrollTop" | "scrollHeight" | "clientHeight") => Object.getOwnPropertyDescriptor(Element.prototype, name);
  const top0 = own("scrollTop");
  const sh0 = own("scrollHeight");
  const ch0 = own("clientHeight");
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const box = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    if (isLog(this)) return box(LOG_TOP, VIEW);
    const log = this.closest('[data-testid="tutor-log"]');
    if (log && this.dataset.turn !== undefined) {
      const y = layout(log).tops.get(this) ?? 0;
      return box(LOG_TOP + y - (scrolls.get(log) ?? 0), heightOf(this));
    }
    return rect.call(this);
  };
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return isLog(this) ? (scrolls.get(this) ?? 0) : (top0?.get?.call(this) ?? 0);
    },
    set(this: Element, v: number) {
      if (isLog(this)) scrolls.set(this, Math.max(0, Math.min(v, maxScroll(this))));
      else top0?.set?.call(this, v);
    },
  });
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      return isLog(this) ? layout(this).height : (sh0?.get?.call(this) ?? 0);
    },
  });
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) {
      return isLog(this) ? VIEW : (ch0?.get?.call(this) ?? 0);
    },
  });
  restore = () => {
    proto.getBoundingClientRect = rect;
    for (const [name, d] of [["scrollTop", top0], ["scrollHeight", sh0], ["clientHeight", ch0]] as const) {
      if (d) Object.defineProperty(Element.prototype, name, d);
    }
  };
});

afterEach(() => {
  cleanup();
  restore?.();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
});

const LONG = "x".repeat(800); // 400 px
const LONGER = "x".repeat(1600); // 800 px
const q = (id: string): ChatTurn => ({ id, role: "user", text: `Question ${id}` });
const a = (id: string, text: string): ChatTurn => ({ id, role: "assistant", text });

const base: TutorChatViewProps = {
  turns: [],
  busy: false,
  draft: "",
  status: null,
  deeperAvailable: false,
  aboutQuote: false,
  onDraft: () => {},
  onSend: () => {},
  onStarter: () => {},
  onSaveToNote: () => {},
  onDeeper: () => {},
  onCopy: () => {},
};

const log = () => screen.getByTestId("tutor-log");
/** Where the turn's first line is on screen, relative to the top of the chat's visible area. */
const shownAt = (id: string) => {
  const li = log().querySelector<HTMLElement>(`[data-turn="${id}"]`)!;
  return li.getBoundingClientRect().top - LOG_TOP;
};

describe("scrollTopFor", () => {
  it("puts the element 4 px under the log's top, never past either end", () => {
    expect(scrollTopFor({ top: 500 }, { top: 100, scrollTop: 50, scrollHeight: 2000, clientHeight: 200 })).toBe(446);
    expect(scrollTopFor({ top: 500 }, { top: 100, scrollTop: 50, scrollHeight: 600, clientHeight: 200 })).toBe(400);
    expect(scrollTopFor({ top: 90 }, { top: 100, scrollTop: 0, scrollHeight: 600, clientHeight: 200 })).toBe(0);
  });
});

describe("the chat's scroll", () => {
  it("a stored chat that loads shows its latest question at the top, its answer under it (not the very end)", () => {
    render(<TutorChatView {...base} turns={[q("q1"), a("a1", LONG), q("q2"), a("a2", LONGER)]} />);
    expect(shownAt("q2")).toBe(4);
    expect(log().scrollTop).toBeLessThan(maxScroll(log()));
  });

  it("a new answer follows its words until its first line is at the top, then stays there", () => {
    const old = [q("q1"), a("a1", LONG)];
    const { rerender } = render(<TutorChatView {...base} turns={old} />);
    rerender(<TutorChatView {...base} busy turns={[...old, q("q2"), a("a2", "")]} />);
    // Short so far: as far down as it goes, the start of the answer in view.
    expect(log().scrollTop).toBe(maxScroll(log()));
    expect(shownAt("a2")).toBeGreaterThanOrEqual(0);
    rerender(<TutorChatView {...base} busy turns={[...old, q("q2"), a("a2", LONG)]} />);
    expect(shownAt("a2")).toBe(4);
    rerender(<TutorChatView {...base} busy turns={[...old, q("q2"), a("a2", LONGER)]} />);
    expect(shownAt("a2")).toBe(4);
    rerender(<TutorChatView {...base} turns={[...old, q("q2"), a("a2", LONGER)]} />);
    expect(shownAt("a2")).toBe(4);
    // Not at the end: she reads from the first line down.
    expect(log().scrollTop).toBeLessThan(maxScroll(log()));
  });

  it("once she scrolls herself it never moves under her; her next question follows again", () => {
    const old = [q("q1"), a("a1", LONG)];
    const { rerender } = render(<TutorChatView {...base} turns={old} />);
    rerender(<TutorChatView {...base} busy turns={[...old, q("q2"), a("a2", "x".repeat(80))]} />);
    const placed = log().scrollTop;
    // She scrolls up to read the earlier answer.
    log().scrollTop = 30;
    fireEvent.scroll(log());
    rerender(<TutorChatView {...base} busy turns={[...old, q("q2"), a("a2", LONGER)]} />);
    expect(log().scrollTop).toBe(30);
    expect(placed).not.toBe(30);
    rerender(<TutorChatView {...base} turns={[...old, q("q2"), a("a2", LONGER)]} />);
    expect(log().scrollTop).toBe(30);

    const more = [...old, q("q2"), a("a2", LONGER)];
    rerender(<TutorChatView {...base} busy turns={[...more, q("q3"), a("a3", LONG)]} />);
    expect(shownAt("a3")).toBe(4);
  });

  it("a wheel turn also stops the following", () => {
    const old = [q("q1"), a("a1", LONG)];
    const { rerender } = render(<TutorChatView {...base} turns={old} />);
    rerender(<TutorChatView {...base} busy turns={[...old, q("q2"), a("a2", "x".repeat(40))]} />);
    const at = log().scrollTop;
    fireEvent.wheel(log(), { deltaY: -40 });
    rerender(<TutorChatView {...base} busy turns={[...old, q("q2"), a("a2", LONGER)]} />);
    expect(log().scrollTop).toBe(at);
  });
});

describe("the chat tells the notepad she is chatting", () => {
  const STREAM = [
    { type: "start", messageMetadata: { model: "groq:x", answerId: "33333333-3333-4333-8333-333333333333", questionId: "q", deeper: false } },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: "An answer." },
    { type: "text-end", id: "0" },
    { type: "finish" },
  ];
  function api(messages: unknown[] = []): TutorApi {
    const fetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (b.mode === "load") return Response.json({ messages, deeperAvailable: false });
      return new Response(STREAM.map((l) => `data: ${JSON.stringify(l)}\n\n`).join(""), { status: 200 });
    });
    return { fetch: fetch as unknown as typeof globalThis.fetch, writeClipboard: vi.fn(async () => {}) };
  }
  const props = (onActive: () => void, over: { quote?: string | null; messages?: unknown[] } = {}) => ({
    noteId: null,
    quote: over.quote ?? null,
    where: () => ({ kind: "other" as const }),
    resolveNoteId: async () => null,
    onSaveToNote: () => {},
    onActive,
    api: api(over.messages),
  });

  it("the box taking focus, and a starter tapped", async () => {
    const onActive = vi.fn();
    render(<TutorChat {...props(onActive, { quote: "PV" })} />);
    await act(async () => {});
    expect(onActive).not.toHaveBeenCalled();
    fireEvent.focus(screen.getByRole("textbox", { name: "Ask the tutor" }));
    expect(onActive).toHaveBeenLastCalledWith("focus");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Explain this simply" }));
    });
    expect(onActive).toHaveBeenCalledWith("ask");
  });

  it("a stored chat with messages", async () => {
    const onActive = vi.fn();
    render(<TutorChat {...props(onActive, { messages: [{ id: "m1", role: "user", text: "Hi", model: null }] })} />);
    await act(async () => {});
    expect(onActive).toHaveBeenCalledWith("messages");
  });

  it("an empty stored chat says nothing", async () => {
    const onActive = vi.fn();
    render(<TutorChat {...props(onActive)} />);
    await act(async () => {});
    expect(onActive).not.toHaveBeenCalled();
  });
});

"use client";

import { useEffect, useRef, useState } from "react";
import { AssistantMessage, TypingDots, UserMessage } from "@/components/chat/message";
import { MessageList, type MessageListHandle } from "@/components/chat/message-list";
import { Button } from "@/components/ui/button";
import { useMotionMode } from "@/lib/motion/use-calm";

/* The prototype's script and replies (main-flow.html 4236-4248). The third
   reply's draft card is another ticket; only its sentence is replayed here. */
const SCRIPT = ["What exactly is asked?", "Run both forecasts", "Draft the report"];
const SEED =
  "I've read the brief and the data. You forecast the next 8 weeks of demand for three products with two methods, then compare how accurate they are. Where do you want to start?";
const REPLIES: { text: string; sources: string[] }[] = [
  {
    text: [
      "Three things, from the brief:",
      "",
      "1. Forecast weeks 45 to 52 for products A, B and C.",
      "2. Use Holt-Winters and a seasonal naive baseline.",
      "3. Report MAPE for each and say which you would trust, in at most 4 pages.",
    ].join("\n"),
    sources: ["A3_brief.pdf, p. 2"],
  },
  {
    text: [
      "Done on `weekly_demand.csv`, 104 weeks per product.",
      "",
      "MAPE",
      "| Product | Holt-Winters | Seasonal naive |",
      "|---|---|---|",
      "| A | **6.8%** | 11.2% |",
      "| B | **9.1%** | 9.4% |",
      "| C | 14.3% | **12.0%** |",
      "",
      "Holt-Winters wins on A and B. C is too erratic for it, the baseline does better.",
    ].join("\n"),
    sources: ["weekly_demand.csv · Lecture 6, slides 14 to 22"],
  },
  {
    text: "Here is a first draft. Section 4 is your conclusion, I wrote it from what you said about product C.",
    sources: [],
  },
];
const EXTRA = "This one arrived while you were scrolled up. The chat did not jump to it.";

type Item =
  | { id: number; role: "user"; text: string; animate: boolean }
  | { id: number; role: "typing" }
  | {
      id: number;
      role: "assistant";
      text: string;
      sources: string[];
      complete: boolean;
      animate: boolean;
    };

const START: Item[] = [{ id: 0, role: "assistant", text: SEED, sources: [], complete: true, animate: false }];

export default function ChatPreview() {
  const mode = useMotionMode();
  const list = useRef<MessageListHandle>(null);
  const [items, setItems] = useState<Item[]>(START);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState(false);
  const [pinned, setPinned] = useState(true);
  const nextId = useRef(1);
  const replyId = useRef(-1);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };

  const patch = (id: number, change: Partial<Extract<Item, { role: "assistant" }>>) =>
    setItems((all) =>
      all.map((it) => (it.id === id && it.role === "assistant" ? { ...it, ...change } : it)),
    );

  const send = () => {
    if (busy || step >= SCRIPT.length) return;
    const reply = REPLIES[step];
    const userId = nextId.current++;
    const typingId = nextId.current++;
    const id = nextId.current++;
    replyId.current = id;
    setBusy(true);
    setStep(step + 1);
    setItems((all) => [
      ...all,
      { id: userId, role: "user", text: SCRIPT[step], animate: true },
      { id: typingId, role: "typing" },
    ]);
    list.current?.scrollToEnd();

    later(() => {
      setItems((all) => [
        ...all.filter((it) => it.id !== typingId),
        {
          id,
          role: "assistant",
          text: stream ? "" : reply.text,
          sources: stream ? [] : reply.sources,
          complete: !stream,
          animate: true,
        },
      ]);
      if (!stream) return;
      // Streamed: a chunk of about 14 characters every 90 ms, sources at the end.
      let at = 0;
      const feed = () => {
        at = Math.min(reply.text.length, at + 14);
        const done = at >= reply.text.length;
        patch(id, {
          text: reply.text.slice(0, at),
          ...(done ? { sources: reply.sources, complete: true } : {}),
        });
        if (!done) later(feed, 90);
      };
      later(feed, 400);
    }, 700);
  };

  const addWhileUp = () => {
    const id = nextId.current++;
    setItems((all) => [
      ...all,
      { id, role: "assistant", text: EXTRA, sources: [], complete: true, animate: true },
    ]);
  };

  const reset = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setItems(START);
    setStep(0);
    setBusy(false);
    list.current?.scrollToEnd();
  };

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-5 py-8">
      <header className="space-y-2">
        <h1 className="type-h26 font-display text-ink">Chat messages</h1>
        <p className="text-[14px] text-ink-2">
          Replays the prototype&apos;s three replies: a list, a table and source lines. Replies type
          at 14 to 22 ms a character and never take more than 2.4 s. Tap a reply while it types to
          finish it. With reduced motion, or <span className="font-mono">?fast=1</span>, replies show
          at once.
        </p>
        <p className="font-mono text-[13px] text-ink-3">
          motion: <span data-testid="motion-mode">{mode}</span> · pinned:{" "}
          <span data-testid="pinned">{pinned ? "yes" : "no"}</span>
        </p>
      </header>

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <div className="flex h-[560px] w-full flex-col overflow-hidden rounded-[20px] border border-line md:max-w-[390px]">
          <MessageList ref={list} onPinnedChange={setPinned}>
            {items.map((it) => {
              if (it.role === "user") return <UserMessage key={it.id} text={it.text} animate={it.animate} />;
              if (it.role === "typing") return <TypingDots key={it.id} />;
              return (
                <AssistantMessage
                  key={it.id}
                  text={it.text}
                  sources={it.sources}
                  complete={it.complete}
                  animate={it.animate}
                  onDone={() => {
                    if (it.id === replyId.current) setBusy(false);
                  }}
                />
              );
            })}
          </MessageList>
        </div>

        <section className="space-y-4 md:flex-1">
          <div className="space-y-2">
            <p className="text-[14px] text-ink-2">
              Next: <span className="font-medium text-ink">{SCRIPT[step] ?? "all three replayed"}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={send} disabled={busy || step >= SCRIPT.length}>
                Send
              </Button>
              <Button size="sm" variant="secondary" onClick={reset}>
                Start over
              </Button>
            </div>
            <label className="flex items-center gap-2 text-[14px] text-ink-2">
              <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} />
              Stream the reply in chunks (types only what has arrived)
            </label>
          </div>

          <div className="space-y-2">
            <p className="text-[14px] text-ink-2">
              Pinning check: scroll the chat up more than 40 px, so pinned reads no, then add a
              message. The chat should stay where you are. Scroll back to the bottom and it pins again.
            </p>
            <Button size="sm" variant="secondary" onClick={addWhileUp}>
              Add a message
            </Button>
          </div>
        </section>
      </div>
    </main>
  );
}

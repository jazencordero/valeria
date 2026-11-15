"use client";

/**
 * /dev/tutor (M2-28): the notes panel with the tutor switched on, note on top and chat below,
 * with plain data and no requests (the panel's actions and the tutor's requests are fakes here).
 * Both handles work: the one between the note and the chat, and (from 700 px) the panel's left
 * edge, whose width is remembered on this device. Under 700 px the panel is the modal sheet.
 *
 * States (buttons, or /dev/tutor#empty, #mid, #budget):
 * - empty: a fresh highlight, the three starters (tap one: a made-up answer streams in);
 * - mid: an answer still arriving;
 * - budget: the month's tutor budget is spent, so the answer came from a free model and
 *   "Go deeper" is not offered.
 */
import { useEffect, useState } from "react";
import type { NotepadContextResult, NotepadSaveResult } from "@/app/(app)/notes/actions";
import type { AddCardsResult, ExamChoicesResult } from "@/app/(app)/notes/card-actions";
import { NotepadView, openNotepad, type NotepadActions } from "@/components/notes/notepad";
import type { TutorApi, TutorPreview } from "@/components/tutor/tutor-chat";
import { Button } from "@/components/ui/button";

type Demo = "empty" | "mid" | "budget";

const FAKE_NOTE = "00000000-0000-4000-8000-000000000001";
const FREE_MODEL = "groq:openai/gpt-oss-120b";
const QUOTE =
  "The present value of a future cash flow is the amount that, invested today at the discount rate, grows to that cash flow.";

const ANSWER =
  "Present value asks: what is money I get later worth to me today?\n\n" +
  "Say you get 110 euros in one year and the bank pays 10% a year. Put 100 in the bank today and it grows to " +
  "100 × 1.10 = 110. So the 110 later is worth 100 now: PV = 110 / 1.10 = 100.\n\n" +
  "Check: what is 121 euros in two years worth today at 10%?";

const PREVIEWS: Record<Demo, TutorPreview> = {
  empty: { turns: [], deeperAvailable: true },
  mid: {
    turns: [
      { id: "q1", role: "user", text: "Explain this simply" },
      { id: "a1", role: "assistant", text: ANSWER.slice(0, 150) },
    ],
    busy: true,
    deeperAvailable: true,
  },
  budget: {
    turns: [
      { id: "q1", role: "user", text: "Explain this simply" },
      { id: "a1", role: "assistant", text: ANSWER, model: FREE_MODEL, answerId: "00000000-0000-4000-8000-0000000000a1" },
    ],
    deeperAvailable: false,
  },
};

const ACTIONS: NotepadActions = {
  save: async (input) => ({ ok: true, id: input.id ?? FAKE_NOTE }) as NotepadSaveResult,
  context: async () => ({ ok: true, label: "Lecture 3 · Present value" }) as NotepadContextResult,
  addCards: async (_id, cards) => ({ ok: true, added: cards.length, skipped: 0, course: "Corporate Finance" }) as AddCardsResult,
  exams: async () => ({ ok: true, exams: [] }) as ExamChoicesResult,
};

/** A made-up UI message stream, a few words at a time. */
function fakeStream(text: string): Response {
  const words = text.split(/(?<= )/);
  const enc = new TextEncoder();
  const line = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(line({ type: "start", messageMetadata: { model: FREE_MODEL, questionId: null, answerId: null, deeper: false } }));
      controller.enqueue(line({ type: "text-start", id: "0" }));
      for (const delta of words) {
        await new Promise((r) => setTimeout(r, 40));
        controller.enqueue(line({ type: "text-delta", id: "0", delta }));
      }
      controller.enqueue(line({ type: "text-end", id: "0" }));
      controller.enqueue(line({ type: "finish" }));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "x-tutor-model": FREE_MODEL } });
}

const API: TutorApi = {
  fetch: async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { mode?: string };
    if (body.mode === "load") return Response.json({ messages: [], deeperAvailable: false });
    if (body.mode === "copy") return Response.json({ text: "A study prompt would be here.", note: null });
    return fakeStream(ANSWER);
  },
  writeClipboard: async () => {},
};

export default function TutorDevPage() {
  const [demo, setDemo] = useState<Demo | null>(null);
  const [opened, setOpened] = useState(0);

  function pick(d: Demo) {
    setDemo(d);
    setOpened((n) => n + 1);
  }

  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.slice(1);
      if (h === "empty" || h === "mid" || h === "budget") pick(h);
    };
    const t = window.setTimeout(fromHash, 0);
    window.addEventListener("hashchange", fromHash);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("hashchange", fromHash);
    };
  }, []);

  // Open the panel once the state is set, so the chat mounts with it.
  useEffect(() => {
    if (opened > 0) openNotepad({ quote: QUOTE });
  }, [opened]);

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Tutor</h1>
        <p className="ink-2">
          The notes panel with the tutor on: the note on top, the chat below and a handle between them. From 700 px the
          panel&apos;s left edge drags its width (360 px up to 70% of the window, remembered); under 700 px it is a sheet.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => pick("empty")} data-testid="open-empty">
            Empty
          </Button>
          <Button onClick={() => pick("mid")} data-testid="open-mid">
            Mid-answer
          </Button>
          <Button onClick={() => pick("budget")} data-testid="open-budget">
            Over budget
          </Button>
        </div>
      </header>
      <p className="ink-2">
        Lecture text stands here, so you can see the panel next to it on a wide screen. {QUOTE} A euro today can earn
        interest, so it beats a euro tomorrow.
      </p>
      <NotepadView
        pathname="/dev/tutor"
        actions={ACTIONS}
        tutor
        tutorApi={API}
        tutorPreview={demo ? PREVIEWS[demo] : undefined}
      />
    </main>
  );
}

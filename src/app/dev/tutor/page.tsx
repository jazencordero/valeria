"use client";

/**
 * /dev/tutor (M2-28): the notes panel with the tutor switched on, note on top and chat below,
 * with plain data and no requests (the panel's actions and the tutor's requests are fakes here).
 * Both handles work: the one between the note and the chat, and (from 700 px) the panel's left
 * edge, whose width is remembered on this device. Under 700 px the panel is the modal sheet.
 *
 * States (buttons, or /dev/tutor#empty, #mid, #budget, #levels, #meter0, #meter8, #meter85, #study):
 * - empty: a fresh highlight, the three starters (tap one: a made-up answer streams in);
 * - mid: an answer still arriving;
 * - budget: the month's tutor budget is spent, so the answer came from a free model, "Go deeper"
 *   is not offered, the picker is the one line "Free model this month" and the chip is full;
 * - levels: the picker with its three levels (Balanced chosen), an answer from the middle model;
 * - meter0: a fresh month, 0.20 EUR used: "Less than 1 of 150 EUR used. About 149 EUR left." and
 *   the default-based estimates (roughly 300,000 Quick, 15,000 Balanced, 2,300 Deep);
 * - meter8 / meter85: the usage chip's popover open at about 8% and about 85% (amber);
 * - study: the course's study-rule question (Yes / No / Not sure) above the chat.
 */
import { useEffect, useState } from "react";
import type { NotepadContextResult, NotepadSaveResult } from "@/app/(app)/notes/actions";
import type { AddCardsResult, ExamChoicesResult } from "@/app/(app)/notes/card-actions";
import { NotepadView, openNotepad, type NotepadActions } from "@/components/notes/notepad";
import type { TutorApi, TutorPreview } from "@/components/tutor/tutor-chat";
import type { TutorMeter } from "@/components/tutor/tutor-controls";
import { Button } from "@/components/ui/button";

const DEMOS = ["empty", "mid", "budget", "levels", "meter0", "meter8", "meter85", "study"] as const;
type Demo = (typeof DEMOS)[number];

const FAKE_NOTE = "00000000-0000-4000-8000-000000000001";
const FREE_MODEL = "groq:openai/gpt-oss-120b";
const QUOTE =
  "The present value of a future cash flow is the amount that, invested today at the discount rate, grows to that cash flow.";

const ANSWER =
  "Present value asks: what is money I get later worth to me today?\n\n" +
  "Say you get 110 euros in one year and the bank pays 10% a year. Put 100 in the bank today and it grows to " +
  "100 × 1.10 = 110. So the 110 later is worth 100 now: PV = 110 / 1.10 = 100.\n\n" +
  "Check: what is 121 euros in two years worth today at 10%?";

const MIDDLE_MODEL = "anthropic:claude-sonnet-5-5";
const COURSE = "00000000-0000-4000-8000-0000000000c1";

/**
 * A made-up allowance: `fraction` of 150 EUR used (or `usedEur`), the estimates from what is left
 * at the default cost of one answer (src/server/tutor/budget.ts, `DEFAULT_ANSWER_TOKENS`, before
 * she has 30 answers at a level): Quick 0.000506 EUR, Balanced 0.01012, Deep 0.06624.
 */
function meter(fraction: number, usedEur = 150 * fraction): TutorMeter {
  const left = 150 - usedEur;
  return {
    usedEur,
    budgetEur: 150,
    fraction,
    resetsOn: "2026-12-01",
    paidAvailable: fraction < 1,
    levels: {
      quick: { answersLeft: Math.floor(left / 0.000506), basis: "default" },
      balanced: { answersLeft: Math.floor(left / 0.01012), basis: "default" },
      deep: { answersLeft: Math.floor(left / 0.06624), basis: "default" },
    },
  };
}

const ANSWERED = [
  { id: "q1", role: "user" as const, text: "Explain this simply" },
  { id: "a1", role: "assistant" as const, text: ANSWER, model: MIDDLE_MODEL, answerId: "00000000-0000-4000-8000-0000000000a1" },
];

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
    meter: meter(1),
  },
  levels: { turns: ANSWERED, deeperAvailable: true, level: "balanced", meter: meter(0.08), draft: "And with 5% instead?" },
  meter0: { turns: ANSWERED, deeperAvailable: true, meter: meter(0.2 / 150, 0.2), meterOpen: true },
  meter8: { turns: ANSWERED, deeperAvailable: true, meter: meter(0.08), meterOpen: true },
  meter85: { turns: ANSWERED, deeperAvailable: true, level: "deep", meter: meter(0.85), meterOpen: true },
  study: {
    turns: [],
    deeperAvailable: true,
    meter: meter(0.08),
    study: { courseId: COURSE, courseName: "Corporate Finance", rule: "unknown" },
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
    if (body.mode === "usage") return Response.json({ meter: meter(0.08) });
    if (body.mode === "study-rule") return Response.json({ ok: true, rule: "allowed" });
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
      if ((DEMOS as readonly string[]).includes(h)) pick(h as Demo);
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
          <Button onClick={() => pick("levels")} data-testid="open-levels">
            Model picker
          </Button>
          <Button onClick={() => pick("meter0")} data-testid="open-meter0">
            Allowance under 1 EUR
          </Button>
          <Button onClick={() => pick("meter8")} data-testid="open-meter8">
            Allowance 8%
          </Button>
          <Button onClick={() => pick("meter85")} data-testid="open-meter85">
            Allowance 85%
          </Button>
          <Button onClick={() => pick("study")} data-testid="open-study">
            Study rule question
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

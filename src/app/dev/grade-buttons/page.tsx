"use client";

import { useState } from "react";
import { GradeButtons } from "@/components/session/grade-buttons";
import { useSessionKeys } from "@/components/session/use-session-keys";
import type { CardType } from "@/lib/study/bite";
import type { Grade } from "@/lib/study/memory";
import type { GradeMode, SessionPhase } from "@/lib/study/session";

const NEXT_TWO = { 1: "1 min", 3: "3 d" } as const;
const NEXT_FOUR = { 1: "1 min", 2: "6 min", 3: "3 d", 4: "8 d" } as const;
const NAMES: Record<Grade, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export default function GradeButtonsPage() {
  const [mode, setMode] = useState<GradeMode>("two");
  const [phase, setPhase] = useState<SessionPhase>("graded");
  const [cardType, setCardType] = useState<CardType>("basic");
  const [last, setLast] = useState("nothing yet");

  const log = (s: string) => setLast(s);
  const grade = (g: Grade, via: string) =>
    log(`${via}: grade ${g} (${mode === "two" ? (g === 1 ? "Missed" : "Got it") : NAMES[g]})`);

  useSessionKeys(
    { phase, cardType, gradeMode: mode },
    {
      onReveal: () => log("key: reveal"),
      onChoose: (o) => log(`key: choose option ${o + 1}`),
      onGrade: (g) => grade(g, "key"),
      onContinue: () => log("key: continue"),
      onCheck: () => log("key: check the answer"),
    },
  );

  const pill = (on: boolean) =>
    "rounded-full border border-solid px-3 py-1 text-[13px] " +
    (on ? "border-ink bg-ink text-paper" : "border-line bg-surface text-ink-2");

  return (
    <main className="mx-auto max-w-3xl space-y-10 px-5 py-10">
      <header className="space-y-2">
        <h1 className="type-h30">Grade buttons and keyboard</h1>
        <p className="ink-2">Focus lands on the passing button. Keys follow the state below.</p>
      </header>

      <section className="space-y-3" aria-labelledby="two-h">
        <h2 id="two-h" className="mono ink-3">
          TWO BUTTONS
        </h2>
        <GradeButtons mode="two" next={NEXT_TWO} onGrade={(g) => grade(g, "click (two)")} autoFocus={mode === "two"} />
      </section>

      <section className="space-y-3" aria-labelledby="four-h">
        <h2 id="four-h" className="mono ink-3">
          FOUR BUTTONS (ANKI)
        </h2>
        <GradeButtons mode="four" next={NEXT_FOUR} onGrade={(g) => grade(g, "click (four)")} autoFocus={mode === "four"} />
      </section>

      <section className="space-y-3" aria-labelledby="keys-h">
        <h2 id="keys-h" className="mono ink-3">
          KEYBOARD STATE
        </h2>
        <div className="flex flex-wrap gap-2">
          {(["two", "four"] as const).map((m) => (
            <button key={m} type="button" className={pill(mode === m)} onClick={() => setMode(m)}>
              {m} buttons
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {(["front", "graded", "fb", "done"] as const).map((p) => (
            <button key={p} type="button" className={pill(phase === p)} onClick={() => setPhase(p)}>
              {p}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {(["basic", "cloze", "mcq", "explain", "match"] as const).map((t) => (
            <button key={t} type="button" className={pill(cardType === t)} onClick={() => setCardType(t)}>
              {t}
            </button>
          ))}
        </div>
        <textarea
          className="block min-h-20 w-full rounded-2xl border border-solid border-line bg-surface p-3 text-[15px]"
          placeholder="Typing here fires nothing, except Cmd or Ctrl + Enter."
        />
        <p className="mono ink-2" data-testid="last-key" aria-live="polite">
          {last}
        </p>
      </section>

      <section className="flex flex-wrap gap-2" aria-label="Theme">
        {(["light", "dark", "system"] as const).map((t) => (
          <button key={t} type="button" className={pill(false)} onClick={() => setTheme(t)}>
            {t}
          </button>
        ))}
      </section>
    </main>
  );
}

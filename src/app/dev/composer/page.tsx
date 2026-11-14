"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/chat/composer";
import { Suggestion } from "@/components/chat/suggestion";

const STEPS = ["What exactly is asked?", "Make me a plan", "Check my draft"];

function Dock({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-xl rounded-[20px] border border-solid border-line bg-surface px-4 pb-3 pt-1">
      {children}
    </div>
  );
}

/** A working dock: sending makes it busy for 1.5 s, then the next step shows. */
function LiveDock() {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lastInput, setLastInput] = useState(0);
  const [sent, setSent] = useState<string[]>([]);
  const [bounced, setBounced] = useState<string[]>([]);

  useEffect(() => {
    if (!busy) return;
    const t = window.setTimeout(() => {
      setBusy(false);
      setStep((s) => s + 1);
    }, 1500);
    return () => window.clearTimeout(t);
  }, [busy]);

  function send(text: string) {
    setSent((list) => [...list, text]);
    setBusy(true);
  }

  const label = step < STEPS.length ? STEPS[step] : null;

  return (
    <div className="space-y-3">
      <Dock>
        <Suggestion
          label={label}
          busy={busy}
          onSend={send}
          lastInput={lastInput}
          onBounce={(l) => setBounced((list) => [...list, l])}
        />
        <Composer busy={busy} onSend={send} onInput={() => setLastInput((n) => n + 1)} />
      </Dock>
      <dl className="grid max-w-xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="mono ink-3">state</dt>
        <dd className="ink-2" data-testid="state">{busy ? "Reply arriving" : "Idle"}</dd>
        <dt className="mono ink-3">sent</dt>
        <dd className="ink-2" data-testid="sent">{sent.length ? sent.join(" · ") : "Nothing yet"}</dd>
        <dt className="mono ink-3">bounced</dt>
        <dd className="ink-2" data-testid="bounced">
          {bounced.length ? bounced.join(" · ") : "Not yet"}
        </dd>
      </dl>
    </div>
  );
}

export default function ComposerPage() {
  const [run, setRun] = useState(0);

  return (
    <main className="mx-auto max-w-4xl space-y-10 px-5 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Composer and suggestion chip</h1>
        <p className="ink-2">
          Enter sends. Empty text does not. While a reply arrives the send button is off and the chip
          hides. Leave the page alone for 4 seconds and the chip bounces once; each new label gets one
          bounce. With reduced motion there is no bounce.
        </p>
        <Button variant="secondary" size="sm" onClick={() => setRun((n) => n + 1)}>
          Start over
        </Button>
      </header>

      <section className="space-y-3">
        <h2 className="type-h22">Live</h2>
        <LiveDock key={run} />
      </section>

      <section className="space-y-3">
        <h2 className="type-h22">Reply arriving</h2>
        <Dock>
          <Suggestion label="Make me a plan" busy onSend={() => {}} />
          <Composer busy onSend={() => {}} />
        </Dock>
      </section>

      <section className="space-y-3">
        <h2 className="type-h22">No suggestion</h2>
        <Dock>
          <Suggestion label={null} onSend={() => {}} />
          <Composer onSend={() => {}} />
        </Dock>
      </section>
    </main>
  );
}

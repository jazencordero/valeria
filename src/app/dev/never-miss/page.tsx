"use client";

import { useState } from "react";
import {
  NOT_NOW_KEY,
  NeverMiss,
  type NeverMissChoice,
  type ReminderChannel,
} from "@/components/home/never-miss";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { SCHOOLS } from "@/lib/schools";
import { useMotionMode } from "@/lib/motion/use-calm";

type Server = "quick" | "slow" | "never" | "fail";

const SERVERS: { id: Server; label: string }[] = [
  { id: "quick", label: "Answers in 0.3 s" },
  { id: "slow", label: "Answers in 3 s" },
  { id: "never", label: "Never answers (fill)" },
  { id: "fail", label: "Fails" },
];

const CHANNELS: { id: ReminderChannel; label: string }[] = [
  { id: "push", label: "Push" },
  { id: "email", label: "Email" },
  { id: "none", label: "None" },
];

const SWITCHES: { cal: boolean; rem: boolean; label: string }[] = [
  { cal: true, rem: true, label: "Both on" },
  { cal: true, rem: false, label: "Calendar only" },
  { cal: false, rem: true, label: "Reminders only" },
  { cal: false, rem: false, label: "Both off (Close)" },
];

const DONE: { title: string; on: NeverMissChoice }[] = [
  { title: "Both, email", on: { calendar: "google", reminders: "email", email: "valeria@example.com" } },
  { title: "Both, push", on: { calendar: "apple", reminders: "push" } },
  { title: "Calendar only", on: { calendar: "outlook", reminders: null } },
  { title: "Reminders only", on: { calendar: null, reminders: "push" } },
];

// A sample subscribe link, so the new tab opens somewhere harmless in the preview.
const SAMPLE_LINK = "https://example.com/?subscribe=ready";

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export default function NeverMissPage() {
  const mode = useMotionMode();
  const [channel, setChannel] = useState<ReminderChannel>("push");
  const [sw, setSw] = useState(0);
  const [server, setServer] = useState<Server>("quick");
  const [count, setCount] = useState(6);
  const [run, setRun] = useState(0);
  const [log, setLog] = useState("");
  const [autoOpen, setAutoOpen] = useState(false);

  const remount = (openNow = false) => {
    setAutoOpen(openNow);
    setRun((r) => r + 1);
  };

  const turnOn = async (choice: NeverMissChoice) => {
    setLog(JSON.stringify(choice));
    if (server === "never") return new Promise<never>(() => {});
    await wait(server === "slow" ? 3000 : 300);
    if (server === "fail") throw new Error("Sample failure");
    return choice.calendar ? { subscribeUrl: SAMPLE_LINK } : undefined;
  };

  const resetNotNow = () => {
    try {
      window.localStorage.removeItem(NOT_NOW_KEY);
    } catch {
      // Storage blocked: nothing to reset.
    }
    remount();
  };

  const { cal, rem } = SWITCHES[sw];
  const key = `${channel}-${sw}-${server}-${count}-${run}`;

  return (
    <main className="mx-auto max-w-4xl space-y-10 px-4 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Never miss one</h1>
        <p className="ink-2">
          The sky card on Home and its sheet. Pick what the server offers, the starting switches and
          how the server answers, then press Set up. Turn on opens a sample page in a new tab when the
          calendar is on. Not now hides the card for 30 days in this browser.
        </p>
        <p className="font-mono text-sm ink-3" data-testid="motion-mode">
          motion: {mode}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setTheme("light")}>
            Light
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setTheme("dark")}>
            Dark
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setTheme("system")}>
            System
          </Button>
        </div>
      </header>

      <section className="space-y-4">
        <h2 className="type-h22">Live</h2>
        <div className="space-y-2">
          <p className="mono ink-3">Reminders the server offers</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Reminders offered">
            {CHANNELS.map((c) => (
              <Chip key={c.id} kind="choice" pressed={channel === c.id} onPressedChange={() => setChannel(c.id)}>
                {c.label}
              </Chip>
            ))}
          </div>
          <p className="mono ink-3">Starting switches</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Starting switches">
            {SWITCHES.map((s, i) => (
              <Chip key={s.label} kind="choice" pressed={sw === i} onPressedChange={() => setSw(i)}>
                {s.label}
              </Chip>
            ))}
          </div>
          <p className="mono ink-3">Server</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Server">
            {SERVERS.map((s) => (
              <Chip key={s.id} kind="choice" pressed={server === s.id} onPressedChange={() => setServer(s.id)}>
                {s.label}
              </Chip>
            ))}
          </div>
          <p className="mono ink-3">Dates in the calendar link</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Dates">
            {[0, 1, 6, 23].map((n) => (
              <Chip key={n} kind="choice" pressed={count === n} onPressedChange={() => setCount(n)}>
                {String(n)}
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button variant="secondary" size="sm" onClick={() => remount()}>
              Start over
            </Button>
            <Button variant="secondary" size="sm" onClick={resetNotNow}>
              Undo Not now
            </Button>
          </div>
          {log ? <p className="mono ink-3 [overflow-wrap:anywhere]">onTurnOn: {log}</p> : null}
        </div>
        <div className="max-w-[420px]">
          <NeverMiss
            key={key}
            dateCount={count}
            reminders={channel}
            schoolName={SCHOOLS.aalto.name}
            initialCalendar={cal}
            initialReminders={rem}
            defaultOpen={autoOpen}
            onTurnOn={turnOn}
          />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="type-h22">Sheet open, working</h2>
        <p className="ink-2">Opens the sheet above with a server that never answers. Press Turn on to see the fill; Start over ends it.</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setServer("never");
            setChannel("push");
            setSw(1);
            remount(true);
          }}
        >
          Set up a working fill
        </Button>
      </section>

      <section className="space-y-4">
        <h2 className="type-h22">Done rows</h2>
        <div className="grid max-w-[420px] gap-4">
          {DONE.map((d) => (
            <div key={d.title} className="space-y-1">
              <p className="mono ink-3">{d.title}</p>
              <NeverMiss
                dateCount={6}
                reminders={d.on.reminders ?? "push"}
                schoolName={SCHOOLS.aalto.name}
                on={d.on}
                onTurnOn={async () => undefined}
              />
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

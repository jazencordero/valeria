"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  HandinSheet,
  type HandinFailReason,
  type HandinReview,
  type Result,
} from "@/components/work/handin-sheet";
import { useMotionMode } from "@/lib/motion/use-calm";

// Made-up sample data. Due 21:00 today in Helsinki, checked at 15:52.
const NOW = "2026-11-14T13:52:00Z";
const REVIEW: HandinReview = {
  fileName: "Assignment3_Forecasting.pdf",
  bytes: 319_488,
  pages: 4,
  to: "Forecasting Methods › Assignment 3",
  due: "2026-11-14T19:00:00Z",
  earlyBy: "5 h 8 min early",
};

type Play = "success" | "slow" | HandinFailReason | "throws";

const PLAYS: { id: Play; label: string }[] = [
  { id: "success", label: "Success" },
  { id: "slow", label: "Success, slow (3 s)" },
  { id: "expired", label: "Expired" },
  { id: "changed", label: "Changed" },
  { id: "refused", label: "Refused" },
  { id: "moodle_down", label: "MyCourses down" },
  { id: "not_shown", label: "Not shown" },
  { id: "throws", label: "Connection drops" },
];

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Retryable failures fail once, then the retry succeeds.
async function fake(play: Play, attempt: number): Promise<Result> {
  await wait(play === "slow" ? 3000 : 300);
  const retried = attempt > 1 && (play === "moodle_down" || play === "throws");
  if (play === "success" || play === "slow" || retried) return { ok: true, submittedAt: NOW };
  if (play === "throws") throw new Error("offline");
  if (play === "refused") {
    return { ok: false, reason: "refused", message: "The submission is closed for this assignment." };
  }
  return { ok: false, reason: play };
}

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export default function HandinSheetPage() {
  const mode = useMotionMode();
  const [play, setPlay] = useState<Play>("success");
  const [open, setOpen] = useState(false);
  // A new key per run so each play starts from the review.
  const [run, setRun] = useState(0);
  const [calls, setCalls] = useState(0);
  const attempts = useRef(0);
  const [lms, setLms] = useState("MyCourses");

  const start = (p: Play) => {
    setPlay(p);
    setRun((n) => n + 1);
    setCalls(0);
    attempts.current = 0;
    setOpen(true);
  };

  return (
    <main className="mx-auto max-w-4xl space-y-10 px-5 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Hand in sheet</h1>
        <p className="ink-2">
          Pick what the server answers, then tap Submit. Down and connection drops fail once, then Try again works. The fill runs for as
          long as the request, at least 900 ms. After a hand-in the sheet is
          locked: close and reopen it and it still shows the receipt.
        </p>
        <p className="font-mono text-sm ink-3" data-testid="motion-mode">
          motion: {mode} · submit calls this run: {calls}
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
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setLms((l) => (l === "MyCourses" ? "Moodle" : "MyCourses"))}
          >
            LMS: {lms}
          </Button>
        </div>
      </header>

      <section className="space-y-3">
        <h2 className="type-h22">Play</h2>
        <div className="flex flex-wrap gap-2">
          {PLAYS.map((p) => (
            <Button key={p.id} onClick={() => start(p.id)} data-testid={`play-${p.id}`}>
              {p.label}
            </Button>
          ))}
        </div>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)} data-testid="reopen">
          Reopen the last sheet
        </Button>
      </section>

      <HandinSheet
        key={run}
        open={open}
        onClose={() => setOpen(false)}
        review={REVIEW}
        lmsName={lms}
        now={NOW}
        onBackHome={() => setOpen(false)}
        onSubmit={() => {
          attempts.current += 1;
          setCalls(attempts.current);
          return fake(play, attempts.current);
        }}
      />
    </main>
  );
}

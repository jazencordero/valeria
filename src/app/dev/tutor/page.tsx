"use client";

/**
 * /dev/tutor (M2-28): the tutor's drawer in its three states, with plain data and no requests.
 * Empty, mid-answer, and resting (every AI service busy: the line shows and her text stays in
 * the box). Under 1100 px it is the modal bottom sheet; from 1100 px the side panel. Pick a
 * state with the buttons, or open /dev/tutor#empty, #mid or #resting.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { RESTING_LINE, TutorView, WIDE_QUERY, type TutorTurn } from "@/components/tutor/tutor";

type Demo = "empty" | "mid" | "resting";

const RESTING_DRAFT = "Can you explain the annuity formula with numbers?";

const MID: TutorTurn[] = [
  { id: "1", role: "user", text: "What is present value? I don't get the formula." },
  {
    id: "2",
    role: "assistant",
    text:
      "Present value is what money you get later is worth to you today.\n\n" +
      "Say a friend promises you 110 euros in one year, and a bank pays 10% a year. " +
      "How much would you put in the bank today to have 110 in a year? 100, because 100 × 1.10 = 110.\n\n" +
      "So PV = FV / (1 + r)^t = 110 / 1.10^1 = 100.\n\nThe longer you wait",
  },
];

const DONE: TutorTurn[] = [
  { id: "1", role: "user", text: "Explain annuities" },
  { id: "2", role: "assistant", text: "An annuity is the same payment every period, for example 100 euros at the end of each year for 3 years.", saved: "saved" },
];

function subscribe(change: () => void) {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener("change", change);
  return () => mq.removeEventListener("change", change);
}

export default function TutorDevPage() {
  const wide = useSyncExternalStore(subscribe, () => window.matchMedia(WIDE_QUERY).matches, () => false);
  const [demo, setDemo] = useState<Demo | null>(null);
  const [draft, setDraft] = useState("");

  function pick(d: Demo) {
    setDemo(d);
    setDraft(d === "resting" ? RESTING_DRAFT : "");
  }

  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.slice(1);
      if (h === "empty" || h === "mid" || h === "resting") {
        setDemo(h);
        setDraft(h === "resting" ? RESTING_DRAFT : "");
      }
    };
    const t = window.setTimeout(fromHash, 0);
    window.addEventListener("hashchange", fromHash);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("hashchange", fromHash);
    };
  }, []);

  const turns = demo === "mid" ? MID : demo === "resting" ? DONE : [];

  return (
    <main className={`mx-auto max-w-3xl space-y-6 px-5 py-10 ${demo && wide ? "pr-[400px]" : ""}`}>
      <header className="space-y-3">
        <h1 className="type-h30">Tutor</h1>
        <p className="ink-2">
          The drawer in its three states. Under 1100 px it is a sheet from the bottom with a scrim; from 1100 px a
          380 px side panel and the page stays usable.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => pick("empty")} data-testid="open-empty">
            Empty
          </Button>
          <Button onClick={() => pick("mid")} data-testid="open-mid">
            Mid-answer
          </Button>
          <Button onClick={() => pick("resting")} data-testid="open-resting">
            Resting
          </Button>
        </div>
      </header>
      <p className="ink-2">
        Lecture text stands here, so you can see the side panel next to it on a wide screen. Present value takes money
        that arrives later and asks what it is worth today. A euro today can earn interest, so it beats a euro tomorrow.
      </p>
      <TutorView
        open={demo !== null}
        wide={wide}
        turns={turns}
        busy={demo === "mid"}
        draft={draft}
        status={demo === "resting" ? RESTING_LINE : null}
        onOpen={() => pick("empty")}
        onClose={() => setDemo(null)}
        onDraft={setDraft}
        onSend={() => {}}
        onNewChat={() => setDemo("empty")}
        onCopy={() => {}}
        onSave={() => {}}
      />
    </main>
  );
}

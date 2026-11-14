"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { useMotionMode } from "@/lib/motion/use-calm";

type Demo = "basic" | "locked" | "long" | "untitled" | null;

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export default function SheetPage() {
  const mode = useMotionMode();
  const [open, setOpen] = useState<Demo>(null);
  const [sending, setSending] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(null);

  const send = () => {
    setSending(true);
    window.setTimeout(() => {
      setSending(false);
      setOpen(null);
    }, 2000);
  };

  return (
    <main className="mx-auto max-w-4xl space-y-10 px-5 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Sheet</h1>
        <p className="ink-2">
          Under 700 px wide it slides up from the bottom. From 700 px it is a
          centred dialog that fades and rises. Escape or a tap on the scrim
          closes it, unless it is locked. Tab stays inside, and focus goes back
          to the button that opened it.
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

      <section className="space-y-3">
        <h2 className="type-h22">States</h2>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setOpen("basic")} data-testid="open-basic">
            Basic
          </Button>
          <Button onClick={() => setOpen("locked")} data-testid="open-locked">
            Locked while sending
          </Button>
          <Button onClick={() => setOpen("long")} data-testid="open-long">
            Long content
          </Button>
          <Button onClick={() => setOpen("untitled")} data-testid="open-untitled">
            No title
          </Button>
        </div>
        <p className="fine">
          Behind the sheet: <a href="#behind" className="underline">a link</a>{" "}
          and <button type="button" className="underline">a button</button>{" "}
          that Tab should never reach while a sheet is open.
        </p>
      </section>

      <Sheet
        open={open === "basic"}
        onClose={close}
        title="Sample sheet"
        initialFocus={confirmRef}
        data-testid="sheet-basic"
      >
        <p className="ink-2 mb-6">
          Sample text. Press Escape, tap outside, or use a button below.
        </p>
        <div className="grid gap-1">
          <Button ref={confirmRef} block size="lg" onClick={close}>
            Done
          </Button>
          <Button variant="text" block onClick={close}>
            Cancel
          </Button>
        </div>
      </Sheet>

      <Sheet
        open={open === "locked"}
        onClose={close}
        locked={sending}
        title="Locked while sending"
        data-testid="sheet-locked"
      >
        <p className="ink-2 mb-6">
          Press Send. For two seconds Escape and the scrim do nothing, then it
          closes by itself.
        </p>
        <div className="grid gap-1">
          <Button block size="lg" loading={sending} loadingLabel="Sending" onClick={send}>
            Send
          </Button>
          <Button variant="text" block disabled={sending} onClick={close}>
            Cancel
          </Button>
        </div>
      </Sheet>

      <Sheet
        open={open === "long"}
        onClose={close}
        title="Long content"
        data-testid="sheet-long"
      >
        <div className="space-y-4 mb-6">
          {Array.from({ length: 14 }, (_, i) => (
            <p key={i} className="ink-2">
              Paragraph {i + 1}. The sheet stops at 92% of the screen height and
              scrolls inside.
            </p>
          ))}
        </div>
        <Button block size="lg" onClick={close}>
          Close
        </Button>
      </Sheet>

      <Sheet
        open={open === "untitled"}
        onClose={close}
        aria-label="Sheet without a title"
        data-testid="sheet-untitled"
      >
        <p className="ink-2 mb-6">No visible title. The dialog is named by its label.</p>
        <Button block size="lg" onClick={close}>
          Close
        </Button>
      </Sheet>
    </main>
  );
}

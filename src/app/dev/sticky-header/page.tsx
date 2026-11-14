"use client";

import { Button } from "@/components/ui/button";
import { StickyHeader } from "@/components/ui/sticky-header";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

const rows = Array.from({ length: 40 }, (_, i) => i + 1);

export default function StickyHeaderPage() {
  return (
    <div className="flex h-dvh flex-col">
      <div className="mx-auto w-full max-w-3xl space-y-3 px-5 pt-8 pb-4">
        <h1 className="type-h30">Sticky header</h1>
        <p className="ink-2">
          The header sticks to the top of the box below. At the top it has no
          shadow. Scroll more than 4 px and it gains a hairline and a soft
          shadow. It also clears the phone&apos;s top safe area.
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
      </div>

      <div
        id="main"
        data-testid="scroller"
        className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto border-t border-line bg-surface"
      >
        <StickyHeader
          padTop="4px"
          className="flex min-h-11 items-center justify-between px-5 pb-1"
          data-testid="sticky-header"
        >
          <span className="font-display text-lg">Sample header</span>
          <Button variant="secondary" size="sm">
            Action
          </Button>
        </StickyHeader>
        <ul className="space-y-2 px-5 py-4">
          {rows.map((n) => (
            <li
              key={n}
              className="rounded-xl border border-line bg-paper px-4 py-3 ink-2"
            >
              Sample row {n}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

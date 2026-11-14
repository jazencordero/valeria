"use client";

import { Button } from "@/components/ui/button";
import { DOODLE_NAMES, Doodle, DoodleDefs } from "@/components/doodle";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

// Sizes the prototype actually uses for each drawing.
const IN_USE: { name: (typeof DOODLE_NAMES)[number]; size: number; where: string }[] = [
  { name: "basic", size: 120, where: "Card type tile" },
  { name: "cup", size: 64, where: "Today's plan is done" },
  { name: "anki", size: 64, where: "Bring your Anki decks" },
  { name: "bite", size: 52, where: "Bite banner" },
  { name: "crown", size: 44, where: "Perfect round" },
  { name: "crown", size: 18, where: "Boss label" },
];

export default function DoodlesPage() {
  return (
    <main className="mx-auto max-w-2xl space-y-10 px-4 py-10">
      <DoodleDefs />
      <header className="space-y-3">
        <h1 className="type-h30">Doodles</h1>
        <p className="ink-2">Ten hand-drawn line drawings sharing one wobble filter.</p>
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
        <h2 className="mono ink-3 font-medium uppercase tracking-[0.04em]">All ten</h2>
        <ul className="grid list-none grid-cols-2 gap-4 sm:grid-cols-5">
          {DOODLE_NAMES.map((name) => (
            <li
              key={name}
              className="flex flex-col items-center gap-2 rounded-xl bg-accent-wash p-3"
              data-testid={`doodle-${name}`}
            >
              <Doodle name={name} size={96} />
              <span className="mono ink-2">{name}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="mono ink-3 font-medium uppercase tracking-[0.04em]">On paper</h2>
        <div className="flex flex-wrap items-end gap-4">
          {DOODLE_NAMES.map((name) => (
            <Doodle key={name} name={name} size={64} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="mono ink-3 font-medium uppercase tracking-[0.04em]">Sizes in use</h2>
        <ul className="list-none space-y-3">
          {IN_USE.map(({ name, size, where }) => (
            <li key={`${name}-${size}`} className="flex items-center gap-4">
              <Doodle name={name} size={size} />
              <span className="ink-2">
                {where} · <span className="mono">{name} {size}px</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

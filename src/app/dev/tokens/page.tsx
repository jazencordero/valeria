import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Tokens · Ready",
};

const COLOURS = [
  { name: "paper", className: "bg-paper" },
  { name: "surface", className: "bg-surface" },
  { name: "ink", className: "bg-ink" },
  { name: "ink-2", className: "bg-ink-2" },
  { name: "ink-3", className: "bg-ink-3" },
  { name: "line", className: "bg-line" },
  { name: "accent", className: "bg-accent" },
  { name: "accent-wash", className: "bg-accent-wash" },
  { name: "butter", className: "bg-butter" },
  { name: "mint", className: "bg-mint" },
  { name: "sky", className: "bg-sky" },
  { name: "due", className: "bg-due" },
] as const;

const MOTION = [
  { name: "quick", value: "180ms", className: "duration-quick ease-out" },
  { name: "base", value: "280ms", className: "duration-base ease-inout" },
  { name: "slow", value: "520ms", className: "duration-slow ease-reward" },
] as const;

export default function TokensPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-12 px-5 py-10">
      <header className="space-y-2">
        <h1 className="type-h30">Design tokens</h1>
        <p className="ink-2">
          Copied from the prototype. Switch the OS between light and dark to
          compare both sets.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="type-h22">Colours</h2>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {COLOURS.map((c) => (
            <li
              key={c.name}
              className="overflow-hidden rounded-xl border border-line bg-paper"
            >
              <div className={`h-16 ${c.className}`} />
              <div className="px-3 py-2">
                <p className="text-sm font-medium text-ink">{c.name}</p>
                <p className="mono ink-3">var(--{c.name})</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="type-h22">Type</h2>
        <div className="space-y-5 rounded-xl border border-line bg-paper p-5">
          <div>
            <p className="mono ink-3">display · Fraunces · type-h30</p>
            <h3 className="type-h30">Know if you&rsquo;ll be ready.</h3>
          </div>
          <div>
            <p className="mono ink-3">display · Fraunces · type-h26</p>
            <h3 className="type-h26">Start studying in 10 seconds.</h3>
          </div>
          <div>
            <p className="mono ink-3">display · Fraunces · type-h22 italic</p>
            <h3 className="type-h22 italic">Three things before Friday</h3>
          </div>
          <div>
            <p className="mono ink-3">sans · Figtree · 15px body</p>
            <p>
              Body text sits at 15px with a 1.45 line height and tabular
              numbers: 0123456789.
            </p>
            <p className="font-medium">Medium 500</p>
            <p className="font-semibold">Semibold 600</p>
          </div>
          <div>
            <p className="mono ink-3">ink-2 · ink-3 · fine</p>
            <p className="ink-2">Secondary text in ink-2.</p>
            <p className="ink-3">Tertiary text in ink-3.</p>
            <p className="fine">Fine print at 13px.</p>
          </div>
          <div>
            <p className="mono ink-3">mono · Geist Mono · mono / mono-in</p>
            <p className="mono">DUE 14 NOV · 23:59</p>
            <p className="mono-in">2 h 30 min left</p>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="type-h22">Motion</h2>
        <p className="fine">Hover a row to run its duration and easing.</p>
        <ul className="space-y-3">
          {MOTION.map((m) => (
            <li
              key={m.name}
              className="group rounded-xl border border-line bg-paper p-3"
            >
              <p className="mono ink-3">
                duration-{m.name} · {m.value}
              </p>
              <div className="mt-2 h-2 rounded-full bg-line">
                <div
                  className={`h-2 w-4 rounded-full bg-accent transition-[width] group-hover:w-full ${m.className}`}
                />
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

"use client";

/**
 * Where you gain most (M3-48): the three concepts on the Progress tab with the
 * largest `weight * (1 - mastery)`, each a small card with its icon, a rose bar
 * and "72% now". One column on a phone, three from 700 px.
 * Source: prototype merged-2.html JS 6029-6038 (progressHTML, .cm3) and CSS
 * 1457-1461, 1502.
 *
 * Plain props: the page passes every concept with its mastery as it stands
 * today (what the forecast is made of: no further study is counted in, so
 * the figure is labelled "now", like "right if it were today"). Ties keep the caller's order (stable sort), as in the prototype.
 */
import { useId } from "react";
import { ConceptIcon, iconFor, type ConceptIconName } from "@/components/exams/concept-icons";
import { Bar } from "@/components/ui/bar";
import type { WeightedConcept } from "@/lib/study/ladder";

export type GainConcept = WeightedConcept & {
  id: string;
  name: string;
  icon?: ConceptIconName;
};

export type GainMostProps = {
  concepts: readonly GainConcept[];
  /** How many cards to show. Default 3. */
  count?: number;
  className?: string;
};

/** The `count` concepts with the largest weight times gap, largest first. */
export function gainMost<T extends WeightedConcept>(concepts: readonly T[], count = 3): T[] {
  return concepts
    .slice()
    .sort((a, b) => b.weight * (1 - b.mastery) - a.weight * (1 - a.mastery))
    .slice(0, count);
}

const LABEL =
  "mono mb-2.5 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]";

export function GainMost({ concepts, count = 3, className = "" }: GainMostProps) {
  const labelId = useId();
  const top = gainMost(concepts, count);
  return (
    <section aria-labelledby={labelId} className={className} data-gain-most="">
      <h3 id={labelId} className={LABEL}>
        WHERE YOU GAIN MOST
      </h3>
      <ul className="grid list-none gap-2.5 p-0 min-[700px]:grid-cols-3">
        {top.map((c) => {
          const pct = Math.round(c.mastery * 100);
          return (
            <li
              key={c.id}
              data-concept={c.id}
              className="grid min-w-0 gap-1.5 rounded-2xl border border-solid border-line p-3"
            >
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <ConceptIcon name={c.icon ?? iconFor(c.name)} size={16} />
                <span className="min-w-0">{c.name}</span>
              </span>
              <Bar value={c.mastery} label={c.name} className="[&>span]:bg-accent" />
              <span className="mono text-right text-ink-2">{pct}% now</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

import type { ReactNode } from "react";

/**
 * Small line icons for exam concepts, copied from the prototype's CICONS set.
 * Drawn on a 24 x 24 grid with a 1.5 stroke in currentColor, so they take the
 * colour of whatever holds them. `iconFor` picks one from a concept's name by
 * keyword; anything it does not know gets the neutral dot.
 */

export type ConceptIconName =
  | "governance"
  | "decision"
  | "sourcing"
  | "contract"
  | "data"
  | "value"
  | "timeSeries"
  | "difference"
  | "chart"
  | "dot";

const PATHS: Record<ConceptIconName, ReactNode> = {
  governance: (
    <>
      <path d="M12 4v15M7 19.5h10M5 8h14" />
      <path d="M5 8l-2.5 5.5h5zM19 8l-2.5 5.5h5z" />
    </>
  ),
  decision: (
    <>
      <circle cx="8" cy="12" r="3.8" />
      <path d="M11.8 12h8.7M17.5 12v3M20.5 12v2.2" />
    </>
  ),
  sourcing: <path d="M4 8.5h14l-3.2-3.2M20 15.5H6l3.2 3.2" />,
  contract: (
    <>
      <path d="M6.5 3.5h7.5l4 4v13h-11.5z" />
      <path d="M9.5 13.5l2 2 3.5-3.8" />
    </>
  ),
  data: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="12" cy="12" r="0.9" />
    </>
  ),
  value: (
    <>
      <ellipse cx="12" cy="7" rx="6" ry="2.4" />
      <path d="M6 7v5c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V7M6 12v5c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4v-5" />
    </>
  ),
  timeSeries: (
    <>
      <path d="M3 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0" />
      <path d="M3 18h18" opacity=".5" />
    </>
  ),
  difference: (
    <>
      <path d="M4 18l5-6 4 3 7-9" />
      <path d="M15 6h5v5" />
    </>
  ),
  chart: <path d="M5 20V6M9 20v-9M13 20v-5M17 20v-3M3 20h18" />,
  dot: <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />,
};

/** Every icon name, in display order. The fallback dot comes last. */
export const CONCEPT_ICON_NAMES = Object.keys(PATHS) as ConceptIconName[];

/**
 * Keyword rules, checked in order. More specific phrases come before broad
 * ones, so "Time series data" is a time series and "Data governance" is
 * governance. Word starts are anchored so "translation" never reads as SLA.
 */
const RULES: [RegExp, ConceptIconName][] = [
  [/\bgovern/, "governance"],
  [/\bdecision/, "decision"],
  [/sourcing\b/, "sourcing"],
  [/\bcontract|\bslas?\b/, "contract"],
  [/\btime[\s-]*series\b/, "timeSeries"],
  [/\bdifferen/, "difference"],
  [/\bchart/, "chart"],
  [/\bvalu|\bmoney/, "value"],
  [/\bdata/, "data"],
];

/** Picks the icon for a concept by keyword; unknown concepts get the dot. */
export function iconFor(conceptName: string): ConceptIconName {
  const name = conceptName.toLowerCase();
  for (const [pattern, icon] of RULES) {
    if (pattern.test(name)) return icon;
  }
  return "dot";
}

export function ConceptIcon({
  name,
  size = 16,
  className,
}: {
  name: ConceptIconName;
  /** Width and height in px. 16 inside a concept tile. */
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      data-icon={name}
      className={[
        "flex-none fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.5]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {PATHS[name] ?? PATHS.dot}
    </svg>
  );
}

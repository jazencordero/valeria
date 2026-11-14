/**
 * Your last 14 days: the exam page rail card with one cell per day, shaded by
 * how many cards were reviewed. Today is the last cell and is outlined.
 * Source: prototype main-flow.html JS 2918-2921 (heat), CSS 660-663 (.hm),
 * the rail card in 2947 (.rcard "YOUR LAST 14 DAYS").
 *
 * Plain props: the page passes the days oldest first, today last, each with
 * its label ("Tue 10 Nov") and count. Each cell carries a text alternative
 * ("Tue 10 Nov: 6 cards") for screen readers and as a hover title.
 */

export type HeatDay = {
  /** "Tue 10 Nov". */
  label: string;
  /** Cards reviewed that day. */
  count: number;
};

export type HeatmapProps = {
  /** Oldest first; the last one is today. Normally 14. */
  days: HeatDay[];
  className?: string;
};

const CARD = "rounded-[20px] border border-solid border-line bg-surface p-4";

const LABEL =
  "mono mb-2.5 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]";

/** Opacity step for a day's count: 0, up to 4, up to 8, up to 12, more. */
export function heatLevel(count: number): 0 | 0.25 | 0.5 | 0.75 | 1 {
  if (count <= 0) return 0;
  if (count <= 4) return 0.25;
  if (count <= 8) return 0.5;
  if (count <= 12) return 0.75;
  return 1;
}

export function heatText(day: HeatDay): string {
  return `${day.label}: ${day.count} ${day.count === 1 ? "card" : "cards"}`;
}

export function Heatmap({ days, className }: HeatmapProps) {
  const last = days.length - 1;
  return (
    <section className={`${CARD}${className ? ` ${className}` : ""}`}>
      <h2 className={LABEL}>YOUR LAST 14 DAYS</h2>
      <ul
        className="grid grid-cols-7 gap-1.5"
        aria-label="Cards reviewed on each of the last 14 days"
      >
        {days.map((d, i) => {
          const o = heatLevel(d.count);
          const text = heatText(d);
          const today = i === last;
          return (
            <li
              key={`${d.label}-${i}`}
              title={text}
              data-level={o}
              aria-current={today ? "date" : undefined}
              className={`relative block aspect-square rounded-[4px]${
                today ? " outline outline-[1.5px] outline-offset-1 outline-ink" : ""
              }`}
            >
              {/* The fill carries the opacity so today's outline stays full ink. */}
              <span
                aria-hidden="true"
                className={`absolute inset-0 rounded-[4px] ${o === 0 ? "bg-line" : "bg-accent"}`}
                style={{ opacity: o === 0 ? 1 : o }}
              />
              <span className="sr-only">{text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

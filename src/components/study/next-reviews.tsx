/**
 * Next reviews: the exam page rail card that says how many cards come back on
 * each of the next few review days, as one mono line:
 * "Today 6 · Tomorrow 4 · Tue 17 3 · Thu 19 5 (last pass)".
 * Source: prototype main-flow.html JS 2913-2917 (rail), CSS 657-659
 * (.nr-list), the rail card in 2946 (.rcard "NEXT REVIEWS").
 *
 * Plain props: the page works out the days and counts (from the deck's due
 * dates) and passes them in order. With no days, or nothing due on any of
 * them, the card says "Nothing scheduled yet."
 */

export type ReviewDay = {
  /** "Today", "Tomorrow", "Tue 17". */
  label: string;
  /** Cards due that day. */
  count: number;
  /** Shown after the count in brackets, for example "last pass". */
  note?: string;
};

export type NextReviewsProps = {
  days: ReviewDay[];
  className?: string;
};

const CARD = "rounded-[20px] border border-solid border-line bg-surface p-4";

const LABEL =
  "mono mb-2.5 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]";

export function NextReviews({ days, className }: NextReviewsProps) {
  const empty = days.length === 0 || days.every((d) => d.count === 0);
  return (
    <section className={`${CARD}${className ? ` ${className}` : ""}`}>
      <h2 className={LABEL}>NEXT REVIEWS</h2>
      {empty ? (
        <p className="text-sm text-ink-2">Nothing scheduled yet.</p>
      ) : (
        <ul className="mono flex flex-wrap gap-x-[0.6em] gap-y-1 text-ink-2">
          {days.map((d, i) => (
            <li key={`${d.label}-${i}`} className="whitespace-nowrap">
              <span>{d.label}</span>{" "}
              <span className="font-medium text-ink">{d.count}</span>
              <span className="sr-only">{d.count === 1 ? " card" : " cards"}</span>
              {d.note && <span className="text-ink-3"> ({d.note})</span>}
              {i < days.length - 1 && (
                <span className="ml-[0.6em] text-ink-3" aria-hidden="true">
                  ·
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

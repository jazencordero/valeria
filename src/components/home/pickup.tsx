/**
 * Home's "pick up where you left off" row (M9-19), under the exam cards.
 * Source: prototype merged.html HTML 1712 (#pickup), CSS 1105-1107
 * (.pickup, .pickup-l, .pickup-t), JS 5530-5535 (renderPickup).
 *
 *   PICK UP WHERE YOU LEFT OFF
 *   Lecture 5 · Sourcing and vendors · 6 min read          [Continue]
 *
 * Plain props, no fetching: `getHomeView`'s `pickup` says which lecture.
 * `minutes` is null while the lecture page is still being written; the line
 * then ends after the title. Continue opens the lecture page (`href`).
 */
import { Button } from "@/components/ui/button";

export type PickupProps = {
  n: number;
  title: string;
  minutes: number | null;
  href: string;
  className?: string;
};

/** "Lecture 5 · Sourcing and vendors · 6 min read". */
export function pickupLine(n: number, title: string, minutes: number | null): string {
  const parts = [`Lecture ${n}`, title];
  if (minutes !== null) parts.push(`${minutes} min read`);
  return parts.join(" · ");
}

export function Pickup({ n, title, minutes, href, className }: PickupProps) {
  return (
    <div
      className={
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-2xl border border-solid " +
        "border-line bg-paper px-3.5 py-3 " +
        (className ?? "")
      }
    >
      <p className="mono col-span-full text-ink-3">PICK UP WHERE YOU LEFT OFF</p>
      <p className="min-w-0 text-[15px] font-medium text-ink">{pickupLine(n, title, minutes)}</p>
      <Button variant="secondary" size="sm" href={href}>
        Continue
      </Button>
    </div>
  );
}

"use client";

/**
 * "THIS WEEK" on Home: the 7-day strip (today filled), the agenda and one
 * line. Source: prototype main-flow.html HTML 1486-1506, CSS 360-370
 * (.week-grid, .wd, .dn, .mk), 431 (.sec-label), 461-464 (.rcard, .agenda)
 * and 371 (.hero-note); the marker pulse is the prototype's JS 4682-4690.
 *
 * Takes plain data: the page builds `week` with `weekModel()` from
 * `src/lib/home/week.ts`.
 *
 * `ref.current.pulse()` pulses each marker in turn (scale up 150 ms, 40 ms
 * apart by day, then springs back), for example right after a hand-in. It
 * does nothing when motion is calm or instant (reduced motion or the test
 * switch), like the prototype.
 */
import { animate } from "motion/react";
import { useEffect, useId, useImperativeHandle, useRef, type Ref } from "react";
import type { WeekMarker, WeekModel } from "@/lib/home/week";
import { ease } from "@/lib/motion/tokens";
import { useCalm } from "@/lib/motion/use-calm";

export type WeekCardHandle = {
  /** Pulses each day's marker in turn. No-op when motion is calm. */
  pulse: () => void;
};

export type WeekCardProps = {
  week: WeekModel;
  ref?: Ref<WeekCardHandle>;
  className?: string;
};

/** Delay between one day's pulse and the next. */
export const PULSE_STAGGER_MS = 40;
const PULSE_UP_S = 0.15;

const MARKER: Record<WeekMarker, string> = {
  due_today: "size-1.5 bg-due",
  deadline: "size-1.5 bg-ink-2",
  done: "size-1.5 bg-accent",
  exam: "size-2 border-[1.5px] border-solid border-accent",
};

const CARD = "rounded-[20px] border border-solid border-line bg-surface p-4";

type Stoppable = { stop: () => void };

export function WeekCard({ week, ref, className }: WeekCardProps) {
  const labelId = useId();
  const calm = useCalm();
  const stripRef = useRef<HTMLDivElement>(null);
  const running = useRef<Stoppable[]>([]);

  function stopAll() {
    running.current.forEach((c) => c.stop());
    running.current = [];
  }

  useImperativeHandle(
    ref,
    () => ({
      pulse() {
        if (calm) return;
        stopAll();
        const marks = stripRef.current?.querySelectorAll<HTMLElement>("[data-marker]") ?? [];
        marks.forEach((el) => {
          const day = Number(el.dataset.day ?? 0);
          const up = animate(
            el,
            { scale: [1, 1.5] },
            { duration: PULSE_UP_S, delay: (day * PULSE_STAGGER_MS) / 1000, ease: ease.out },
          );
          running.current.push(up);
          up.then(() => {
            if (!running.current.includes(up)) return;
            running.current.push(
              animate(el, { scale: [1.5, 1] }, { type: "spring", bounce: 0.3, duration: 0.25 }),
            );
          });
        });
      },
    }),
    [calm],
  );

  useEffect(() => stopAll, []);

  return (
    <section className={className ? `${CARD} ${className}` : CARD} aria-labelledby={labelId}>
      <h2
        id={labelId}
        className="mono mb-2.5 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]"
      >
        This week
      </h2>
      <div ref={stripRef}>
        <div className="grid grid-cols-7" aria-hidden="true">
          {week.days.map((d, i) => (
            <div key={i} className="flex flex-col items-center gap-1">
              <span className="mono text-ink-3">{d.weekday}</span>
              <span
                className={`grid size-7 place-items-center rounded-full text-[15px] font-medium ${
                  d.today ? "bg-ink text-surface" : ""
                }`}
              >
                {d.day}
              </span>
              <span className="grid h-2 place-items-center">
                {d.marker && (
                  <i
                    data-marker={d.marker}
                    data-day={i}
                    className={`block rounded-full ${MARKER[d.marker]}`}
                  />
                )}
              </span>
            </div>
          ))}
        </div>
        {week.summary && <p className="sr-only">{week.summary}</p>}
      </div>
      {week.agenda.length > 0 && (
        <ul className="mt-3.5 list-none border-t border-solid border-line">
          {week.agenda.map((row) => (
            <li
              key={row.id}
              className="grid grid-cols-[56px_1fr] gap-2.5 border-b border-solid border-line py-[9px] text-[13px]"
            >
              <span className="mono pt-px text-ink-3">{row.date}</span>
              <span>{row.title}</span>
            </li>
          ))}
        </ul>
      )}
      {week.line && <p className="mt-3 text-center text-[13px] text-ink-3">{week.line}</p>}
    </section>
  );
}

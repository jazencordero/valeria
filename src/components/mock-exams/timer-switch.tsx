"use client";
/* Mock exams (M3-60): "Timer, about 60 min" on the start screen; the choice is kept per exam. */
import { useId } from "react";
import { useTimerPrefs, writeTimer } from "./timer-prefs";

export function TimerSwitch({ examId, minutes }: { examId: string; minutes: number }) {
  const id = useId();
  const { on } = useTimerPrefs(examId);
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-1.5">
      <label id={`${id}-l`} htmlFor={`${id}-s`} className="text-[15px]">
        Timer, about {minutes} min
      </label>
      <button
        id={`${id}-s`}
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-l`}
        onClick={() => {
          writeTimer(examId, { on: !on, hidden: false });
        }}
        className={`relative h-7 w-12 flex-none rounded-full transition-colors duration-quick before:absolute before:-inset-2 before:content-[''] ${on ? "bg-ink" : "bg-line"}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 size-6 rounded-full bg-surface shadow transition-transform duration-quick ${on ? "translate-x-5" : ""}`}
        />
      </button>
    </div>
  );
}

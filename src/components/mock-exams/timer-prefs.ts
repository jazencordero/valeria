/*
 * Mock exams (M3-60): small per-browser memories, kept in localStorage: her timer choice per exam
 * (on or off, shown or hidden) and the question she was last on in an attempt. Conveniences only:
 * answers and seconds used are stored on the server. Read with useSyncExternalStore, so the
 * server render is the plain default and nothing mismatches on hydration.
 */
import { useSyncExternalStore } from "react";

export type TimerPrefs = { on: boolean; hidden: boolean };

const EVENT = "ready-mock-prefs";
const timerKey = (examId: string) => `ready.mock.timer.${examId}`;
const lastQKey = (attemptId: string) => `ready.mock.q.${attemptId}`;

function read(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked storage: the choice just does not stick.
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function parseTimer(raw: string): TimerPrefs {
  try {
    const o = JSON.parse(raw) as Partial<TimerPrefs>;
    return { on: !!o.on, hidden: !!o.hidden };
  } catch {
    return { on: false, hidden: false };
  }
}

export function useTimerPrefs(examId: string): TimerPrefs {
  const raw = useSyncExternalStore(subscribe, () => read(timerKey(examId)), () => "");
  return parseTimer(raw);
}

export function writeTimer(examId: string, prefs: TimerPrefs): void {
  write(timerKey(examId), JSON.stringify(prefs));
}

export function useLastQuestion(attemptId: string): number | null {
  const raw = useSyncExternalStore(subscribe, () => read(lastQKey(attemptId)), () => "");
  const n = Number(raw);
  return n >= 1 && n <= 4 ? n : null;
}

export function writeLastQuestion(attemptId: string, q: number): void {
  try {
    window.localStorage.setItem(lastQKey(attemptId), String(q));
  } catch {
    // The URL still holds the question.
  }
}

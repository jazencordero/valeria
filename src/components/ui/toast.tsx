"use client";

/**
 * One app-wide toast. Call showToast(text) from anywhere; mount <Toaster />
 * once in the app layout. A dark pill at the bottom centre (above the tab bar
 * on phones) rises in 200 ms, stays 2.6 s, then fades out in 200 ms.
 * A newer toast replaces the older one. No actions inside.
 */
import { motion } from "motion/react";
import { useSyncExternalStore } from "react";
import { calmDuration, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

export const TOAST_IN_MS = 200;
export const TOAST_STAY_MS = 2600;
export const TOAST_OUT_MS = 200;

type ToastState = { id: number; text: string; leaving: boolean } | null;

let state: ToastState = null;
let nextId = 1;
let leaveTimer: ReturnType<typeof setTimeout> | undefined;
let removeTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function clearTimers() {
  clearTimeout(leaveTimer);
  clearTimeout(removeTimer);
}

/** Show a toast. Replaces any toast already showing. */
export function showToast(text: string): void {
  clearTimers();
  const id = nextId++;
  state = { id, text, leaving: false };
  emit();
  // Like the prototype: the stay starts when the rise starts.
  leaveTimer = setTimeout(() => {
    if (state?.id !== id) return;
    state = { ...state, leaving: true };
    emit();
    removeTimer = setTimeout(() => {
      if (state?.id !== id) return;
      state = null;
      emit();
    }, TOAST_OUT_MS);
  }, TOAST_STAY_MS);
}

/** Hide the toast at once (route changes, tests). */
export function clearToast(): void {
  clearTimers();
  if (state === null) return;
  state = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;
const getServerSnapshot = (): ToastState => null;

/** Mount point. Put it once in the app layout. */
export function Toaster() {
  const toast = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const mode = useMotionMode();
  if (!toast) return null;

  const instant = mode === "instant";
  const rise = mode === "full";
  const inDuration = instant ? 0 : rise ? TOAST_IN_MS / 1000 : calmDuration;
  const outDuration = instant ? 0 : rise ? TOAST_OUT_MS / 1000 : calmDuration;

  return (
    <motion.p
      key={toast.id}
      role="status"
      initial={rise ? { opacity: 0, y: 8 } : { opacity: 0 }}
      animate={toast.leaving ? { opacity: 0 } : { opacity: 1, y: 0 }}
      transition={
        toast.leaving
          ? { duration: outDuration, ease: "linear" }
          : { duration: inDuration, ease: rise ? ease.out : "linear" }
      }
      className="pointer-events-none fixed inset-x-4 bottom-[calc(92px+env(safe-area-inset-bottom,0px))] z-[55] mx-auto w-fit max-w-[calc(100%-32px)] rounded-full bg-[var(--btn)] px-4 py-2.5 text-center text-[14px] text-[var(--btn-ink)] shadow-[var(--shadow-lift)] min-[700px]:bottom-8"
    >
      {toast.text}
    </motion.p>
  );
}

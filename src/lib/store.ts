"use client";

import { useEffect, useState } from "react";
import type { AppState } from "./types";

const KEY = "study-app:v0";

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function isoInDays(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Sample data so the app is never empty on first open. */
export function demoState(): AppState {
  return {
    weeklyHours: 6,
    exams: [
      {
        id: uid(),
        name: "Microeconomics",
        date: isoInDays(18),
        topics: [
          {
            id: uid(),
            name: "Supply and demand",
            estHours: 2,
            status: "ready",
            spentMin: 120,
            lastNote: "",
            nextStep: "",
            questions: [],
          },
          {
            id: uid(),
            name: "Elasticity",
            estHours: 3,
            status: "learning",
            spentMin: 60,
            lastNote: "Finished price elasticity, stuck on cross-price examples.",
            nextStep: "Do the 3 cross-price exercises in chapter 5.",
            questions: [
              "What does an elasticity of -2 mean?",
              "Why are necessities usually inelastic?",
              "How do you spot substitutes from cross-price elasticity?",
            ],
          },
          {
            id: uid(),
            name: "Market structures",
            estHours: 4,
            status: "not_started",
            spentMin: 0,
            lastNote: "",
            nextStep: "Skim lecture 6 slides and list the four market types.",
            questions: [],
          },
          {
            id: uid(),
            name: "Game theory basics",
            estHours: 3,
            status: "not_started",
            spentMin: 0,
            lastNote: "",
            nextStep: "Watch the prisoner's dilemma lecture.",
            questions: [],
          },
        ],
      },
    ],
  };
}

/** v0 keeps everything in this browser. Accounts and sync come later (see context/feature-map.md). */
export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    let initial: AppState;
    try {
      const raw = window.localStorage.getItem(KEY);
      initial = raw ? (JSON.parse(raw) as AppState) : demoState();
    } catch {
      initial = demoState();
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load once from storage after mount
    setState(initial);
  }, []);

  useEffect(() => {
    if (!state) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Storage can be unavailable (private mode). The app still works for this visit.
    }
  }, [state]);

  return [state, setState] as const;
}

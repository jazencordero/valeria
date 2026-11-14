import type { AppState, Exam, Topic } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysUntil(date: string, now = new Date()): number {
  const end = new Date(date + "T23:59:59");
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));
}

/** Hours of work still left on one topic. Ready topics count as zero. */
export function hoursLeft(topic: Topic): number {
  if (topic.status === "ready") return 0;
  return Math.max(0.5, topic.estHours - topic.spentMin / 60);
}

export type Readiness = {
  hoursLeft: number;
  hoursAvailable: number;
  days: number;
  /** Positive: hours of slack. Negative: hours behind. */
  gap: number;
  readyCount: number;
  total: number;
};

/**
 * v0 simplification: every exam assumes it gets all of her weekly hours.
 * With several exams close together this is optimistic. See context/decisions.md.
 */
export function readiness(exam: Exam, weeklyHours: number): Readiness {
  const days = daysUntil(exam.date);
  const left = exam.topics.reduce((sum, t) => sum + hoursLeft(t), 0);
  const available = (weeklyHours * days) / 7;
  return {
    hoursLeft: round1(left),
    hoursAvailable: round1(available),
    days,
    gap: round1(available - left),
    readyCount: exam.topics.filter((t) => t.status === "ready").length,
    total: exam.topics.length,
  };
}

export type Pick = { exam: Exam; topic: Topic; reason: string };

/**
 * "I have N minutes": pick the most valuable topic to work on right now.
 * Urgency = hours left on the topic / days until its exam.
 * Topics already in progress get a small boost, because re-entering warm context is cheaper.
 */
export function pickNext(state: AppState): Pick | null {
  let best: { pick: Pick; score: number } | null = null;
  for (const exam of state.exams) {
    const days = daysUntil(exam.date);
    if (days === 0) continue; // exam is over
    for (const topic of exam.topics) {
      if (topic.status === "ready") continue;
      let score = hoursLeft(topic) / days;
      if (topic.status === "learning") score *= 1.25;
      if (!best || score > best.score) {
        const reason =
          topic.status === "learning"
            ? `You're mid-way through this, and ${exam.name} is in ${days} day${days === 1 ? "" : "s"}.`
            : `Not started yet, and ${exam.name} is in ${days} day${days === 1 ? "" : "s"}.`;
        best = { pick: { exam, topic, reason }, score };
      }
    }
  }
  return best?.pick ?? null;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

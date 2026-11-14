export type TopicStatus = "not_started" | "learning" | "ready";

export type Topic = {
  id: string;
  name: string;
  /** Her own guess of total hours this topic needs. */
  estHours: number;
  status: TopicStatus;
  /** Minutes actually spent, logged at the end of each session. */
  spentMin: number;
  /** Where she left off last time. Shown on the resume card. */
  lastNote: string;
  /** The very next thing to do. Shown on the resume card. */
  nextStep: string;
  /** Warm-up questions to get back into context fast. */
  questions: string[];
};

export type Exam = {
  id: string;
  name: string;
  /** YYYY-MM-DD */
  date: string;
  topics: Topic[];
};

export type AppState = {
  weeklyHours: number;
  exams: Exam[];
};

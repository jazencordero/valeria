import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { events } from "./calendar";
import { courses } from "./courses";
import { createdAt, id, oneOf, tstz, userId } from "./users";

export const EXAM_KINDS = ["exam", "quiz"] as const;
export const CARD_TYPES = ["basic", "cloze", "mcq", "match", "explain"] as const;
export const CARD_ORIGINS = ["ai", "anki", "manual", "note"] as const;
export const CARD_STATUSES = ["active", "suspended", "flagged"] as const;
export const SESSION_MODES = ["bite", "tile", "concept", "extra"] as const;

export const exams = pgTable(
  "exams",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    kind: text("kind", { enum: EXAM_KINDS }).notNull().default("exam"),
    at: tstz("at").notNull(),
    /**
     * True when only the day is known and the clock time in `at` is a stand-in: a whole-day
     * exam. It shows no time, and stays "today's exam" until that Helsinki day ends.
     */
    timeIsPlaceholder: boolean("time_is_placeholder").notNull().default(false),
    targetPct: integer("target_pct").notNull().default(80),
    /** A hand-made bundle's `prerequisites`, `threads` and `studyOrder`, as given (M3-53). */
    studyMap: jsonb("study_map"),
    /** Helsinki day (`YYYY-MM-DD`) from which sessions may introduce new cards; null = now. */
    startNewOn: date("start_new_on"),
    /** The grade she aims for, as the bundle gave it (M3-53). */
    gradeTarget: jsonb("grade_target"),
  },
  (t) => [
    index("exams_user_id_idx").on(t.userId),
    index("exams_course_id_idx").on(t.courseId),
    oneOf("exams_kind_check", t.kind, EXAM_KINDS),
  ],
);

export const concepts = pgTable(
  "concepts",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    examId: uuid("exam_id")
      .notNull()
      .references(() => exams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The concept's stable name in a hand-made bundle (M3-53); null for other concepts. */
    slug: text("slug"),
    lecture: text("lecture"),
    position: integer("position").notNull().default(0),
    weight: numeric("weight", { mode: "number" }).notNull().default(1),
    icon: text("icon"),
  },
  (t) => [
    index("concepts_user_id_idx").on(t.userId),
    index("concepts_exam_id_idx").on(t.examId),
  ],
);

export const cards = pgTable(
  "cards",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    examId: uuid("exam_id")
      .notNull()
      .references(() => exams.id, { onDelete: "cascade" }),
    type: text("type", { enum: CARD_TYPES }).notNull(),
    rung: integer("rung").notNull().default(0),
    boss: boolean("boss").notNull().default(false),
    body: jsonb("body").notNull(),
    why: text("why"),
    source: text("source"),
    origin: text("origin", { enum: CARD_ORIGINS }).notNull(),
    status: text("status", { enum: CARD_STATUSES }).notNull().default("active"),
    contentHash: text("content_hash").notNull(),
    /** The card's stable id in a hand-made bundle (M3-53); null for other cards. */
    importId: text("import_id"),
  },
  (t) => [
    index("cards_user_id_idx").on(t.userId),
    index("cards_exam_id_idx").on(t.examId),
    unique("cards_user_content_hash_key").on(t.userId, t.contentHash),
    unique("cards_user_exam_import_id_key").on(t.userId, t.examId, t.importId),
    oneOf("cards_type_check", t.type, CARD_TYPES),
    oneOf("cards_origin_check", t.origin, CARD_ORIGINS),
    oneOf("cards_status_check", t.status, CARD_STATUSES),
  ],
);

/** Markdown documents about one exam (a study plan, exam essentials), from a hand-made bundle (M3-53). */
export const examDocuments = pgTable(
  "exam_documents",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    examId: uuid("exam_id")
      .notNull()
      .references(() => exams.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("exam_documents_user_id_idx").on(t.userId),
    unique("exam_documents_exam_slug_key").on(t.examId, t.slug),
  ],
);

export const cardConcepts = pgTable(
  "card_concepts",
  {
    id: id(),
    createdAt: createdAt(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
  },
  (t) => [
    unique("card_concepts_card_concept_key").on(t.cardId, t.conceptId),
    index("card_concepts_concept_id_idx").on(t.conceptId),
  ],
);

export const cardStates = pgTable(
  "card_states",
  {
    id: id(),
    createdAt: createdAt(),
    cardId: uuid("card_id")
      .notNull()
      .unique()
      .references(() => cards.id, { onDelete: "cascade" }),
    fsrs: jsonb("fsrs").notNull(),
    dueAt: tstz("due_at").notNull().defaultNow(),
    lapses: integer("lapses").notNull().default(0),
    lastReviewAt: tstz("last_review_at"),
  },
  (t) => [index("card_states_due_at_idx").on(t.dueAt)],
);

export const studySessions = pgTable(
  "study_sessions",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    examId: uuid("exam_id")
      .notNull()
      .references(() => exams.id, { onDelete: "cascade" }),
    mode: text("mode", { enum: SESSION_MODES }).notNull(),
    startedAt: tstz("started_at").notNull().defaultNow(),
    endedAt: tstz("ended_at"),
    summary: jsonb("summary"),
  },
  (t) => [
    index("study_sessions_user_id_idx").on(t.userId),
    index("study_sessions_exam_id_idx").on(t.examId),
    oneOf("study_sessions_mode_check", t.mode, SESSION_MODES),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    /** Kept when a session row goes away; the review still counts for FSRS. */
    sessionId: uuid("session_id").references(() => studySessions.id, { onDelete: "set null" }),
    grade: integer("grade").notNull(),
    firstTry: boolean("first_try").notNull(),
    ms: integer("ms"),
    at: tstz("at").notNull().defaultNow(),
  },
  (t) => [
    index("reviews_user_id_idx").on(t.userId),
    index("reviews_card_id_idx").on(t.cardId),
    index("reviews_session_id_idx").on(t.sessionId),
  ],
);

/**
 * Mock exams (M3-60): one whole exam file of her bundle per row, keys and model answers
 * included. `import_id` is the file's own `id`; a new upload updates the row in place (never
 * deletes it), so the attempts below stay.
 */
export const mockExams = pgTable(
  "mock_exams",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    importId: text("import_id").notNull(),
    position: integer("position").notNull().default(0),
    /** The exam file as validated (src/lib/mock-exams/validate.ts). */
    content: jsonb("content").notNull(),
    /** Lecture page slug (the page's file name in the bundle) -> lecture number, for links. */
    lecturePages: jsonb("lecture_pages").$type<Record<string, number>>().notNull().default({}),
  },
  (t) => [
    index("mock_exams_user_id_idx").on(t.userId),
    index("mock_exams_course_id_idx").on(t.courseId),
    unique("mock_exams_user_import_id_key").on(t.userId, t.importId),
  ],
);

/**
 * One sitting of a mock exam. Open while `finished_at` is null (at most one open per exam);
 * a finished one is never overwritten except for `ticks`, `edited`, `score` and `total`.
 * Answers are keyed by item index, part key and tick index (src/lib/mock-exams/types.ts).
 */
export const mockExamAttempts = pgTable(
  "mock_exam_attempts",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    mockExamId: uuid("mock_exam_id")
      .notNull()
      .references(() => mockExams.id, { onDelete: "cascade" }),
    startedAt: tstz("started_at").notNull().defaultNow(),
    finishedAt: tstz("finished_at"),
    secondsUsed: integer("seconds_used").notNull().default(0),
    tfOrder: jsonb("tf_order").$type<number[]>().notNull().default([]),
    trueFalse: jsonb("true_false").$type<Record<string, boolean | null>>().notNull().default({}),
    texts: jsonb("texts").$type<Record<string, string>>().notNull().default({}),
    ticks: jsonb("ticks").$type<Record<string, { index: number; fromCheck: boolean }[]>>().notNull().default({}),
    edited: boolean("edited").notNull().default(false),
    score: jsonb("score"),
    total: numeric("total", { mode: "number" }),
  },
  (t) => [
    index("mock_exam_attempts_user_id_idx").on(t.userId),
    index("mock_exam_attempts_mock_exam_id_idx").on(t.mockExamId),
    uniqueIndex("mock_exam_attempts_one_open_key").on(t.mockExamId).where(sql`finished_at is null`),
  ],
);

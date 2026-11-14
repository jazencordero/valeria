import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { courses } from "./courses";
import { createdAt, id, oneOf, tstz, userId } from "./users";

export const ASSIGNMENT_STATES = ["open", "draft", "submitted", "graded"] as const;

export const assignments = pgTable(
  "assignments",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    moodleId: integer("moodle_id").notNull(),
    cmid: integer("cmid"),
    name: text("name").notNull(),
    introHtml: text("intro_html"),
    dueAt: tstz("due_at"),
    cutoffAt: tstz("cutoff_at"),
    opensAt: tstz("opens_at"),
    acceptsFiles: boolean("accepts_files").notNull().default(false),
    acceptsText: boolean("accepts_text").notNull().default(false),
    needsSubmitButton: boolean("needs_submit_button").notNull().default(false),
    maxFiles: integer("max_files"),
    maxBytes: integer("max_bytes"),
    estimateMin: integer("estimate_min"),
    state: text("state", { enum: ASSIGNMENT_STATES }).notNull().default("open"),
    submittedAt: tstz("submitted_at"),
    firstSeenAt: tstz("first_seen_at").notNull().defaultNow(),
    seenAt: tstz("seen_at"),
  },
  (t) => [
    index("assignments_user_id_idx").on(t.userId),
    index("assignments_course_id_idx").on(t.courseId),
    unique("assignments_user_moodle_key").on(t.userId, t.moodleId),
    oneOf("assignments_state_check", t.state, ASSIGNMENT_STATES),
  ],
);

export const submissions = pgTable(
  "submissions",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    bytes: integer("bytes").notNull(),
    state: text("state").notNull(),
    submittedAt: tstz("submitted_at"),
    receipt: jsonb("receipt"),
  },
  (t) => [
    index("submissions_user_id_idx").on(t.userId),
    index("submissions_assignment_id_idx").on(t.assignmentId),
  ],
);

export const chats = pgTable(
  "chats",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .unique()
      .references(() => assignments.id, { onDelete: "cascade" }),
  },
  (t) => [index("chats_user_id_idx").on(t.userId)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: id(),
    createdAt: createdAt(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    parts: jsonb("parts").notNull(),
  },
  (t) => [index("chat_messages_chat_id_idx").on(t.chatId)],
);

export const drafts = pgTable(
  "drafts",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .unique()
      .references(() => assignments.id, { onDelete: "cascade" }),
    title: text("title"),
    contentMd: text("content_md").notNull().default(""),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("drafts_user_id_idx").on(t.userId)],
);

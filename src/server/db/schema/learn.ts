import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { courseFiles, courses } from "./courses";
import { concepts, exams } from "./study";
import { createdAt, id, oneOf, tstz, userId } from "./users";
import { assignments } from "./work";

export const NOTE_ATTACH_KINDS = ["general", "lecture", "course", "assignment", "exam"] as const;
/** What a tutor chat without a note is about (M2-28). `anchor_id` is that lecture, exam or card. */
export const TUTOR_ANCHOR_KINDS = ["lecture", "exam", "card", "general"] as const;
export const TUTOR_ROLES = ["user", "assistant"] as const;

export const lectures = pgTable(
  "lectures",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    n: integer("n").notNull(),
    title: text("title").notNull(),
    fileId: uuid("file_id").references(() => courseFiles.id, { onDelete: "set null" }),
    opensAt: tstz("opens_at"),
    readAt: tstz("read_at"),
    lastOpenedAt: tstz("last_opened_at"),
  },
  (t) => [
    index("lectures_user_id_idx").on(t.userId),
    index("lectures_course_id_idx").on(t.courseId),
    unique("lectures_user_course_n_key").on(t.userId, t.courseId, t.n),
  ],
);

export const lectureContent = pgTable("lecture_content", {
  id: id(),
  createdAt: createdAt(),
  lectureId: uuid("lecture_id")
    .notNull()
    .unique()
    .references(() => lectures.id, { onDelete: "cascade" }),
  breath: text("breath"),
  minutes: integer("minutes"),
  sections: jsonb("sections").notNull().default([]),
  slideTitles: jsonb("slide_titles").$type<string[]>().notNull().default([]),
  sourceHash: text("source_hash").notNull(),
});

export const lectureConcepts = pgTable(
  "lecture_concepts",
  {
    id: id(),
    createdAt: createdAt(),
    lectureId: uuid("lecture_id")
      .notNull()
      .references(() => lectures.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
  },
  (t) => [
    unique("lecture_concepts_lecture_concept_key").on(t.lectureId, t.conceptId),
    index("lecture_concepts_concept_id_idx").on(t.conceptId),
  ],
);

/** Her notes outlive what they are attached to: links go null, the note stays. */
export const notes = pgTable(
  "notes",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    title: text("title"),
    body: text("body").notNull().default(""),
    quote: text("quote"),
    highlighted: boolean("highlighted").notNull().default(false),
    attachKind: text("attach_kind", { enum: NOTE_ATTACH_KINDS }).notNull().default("general"),
    courseId: uuid("course_id").references(() => courses.id, { onDelete: "set null" }),
    lectureId: uuid("lecture_id").references(() => lectures.id, { onDelete: "set null" }),
    assignmentId: uuid("assignment_id").references(() => assignments.id, {
      onDelete: "set null",
    }),
    examId: uuid("exam_id").references(() => exams.id, { onDelete: "set null" }),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("notes_user_id_idx").on(t.userId),
    oneOf("notes_attach_kind_check", t.attachKind, NOTE_ATTACH_KINDS),
  ],
);

export const highlights = pgTable(
  "highlights",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    lectureId: uuid("lecture_id")
      .notNull()
      .references(() => lectures.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
  },
  (t) => [
    index("highlights_user_id_idx").on(t.userId),
    index("highlights_lecture_id_idx").on(t.lectureId),
  ],
);

/*
 * Tutor chats (M2-28). A chat is the rows of one user with the same key: the note it sits under
 * (`note_id`), or, without a note, its anchor (`anchor_kind` + `anchor_id`, `note_id` null).
 * `reply_to` ties an answer to her question, so a "Go deeper" rerun sits under the same question.
 * Token counts are on answers: from the provider's usage when it gave one, else characters / 4
 * with `tokens_estimated` set. `model` is "provider:model". Deleting the note deletes its chat;
 * deleting her account deletes all of it.
 */
export const tutorMessages = pgTable(
  "tutor_messages",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    noteId: uuid("note_id").references(() => notes.id, { onDelete: "cascade" }),
    anchorKind: text("anchor_kind", { enum: TUTOR_ANCHOR_KINDS }).notNull(),
    anchorId: uuid("anchor_id"),
    quote: text("quote"),
    role: text("role", { enum: TUTOR_ROLES }).notNull(),
    body: text("body").notNull(),
    replyTo: uuid("reply_to").references((): AnyPgColumn => tutorMessages.id, { onDelete: "cascade" }),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    tokensEstimated: boolean("tokens_estimated").notNull().default(false),
  },
  (t) => [
    index("tutor_messages_user_id_created_at_idx").on(t.userId, t.createdAt),
    index("tutor_messages_note_id_idx").on(t.noteId),
    index("tutor_messages_created_at_idx").on(t.createdAt),
    oneOf("tutor_messages_anchor_kind_check", t.anchorKind, TUTOR_ANCHOR_KINDS),
    oneOf("tutor_messages_role_check", t.role, TUTOR_ROLES),
  ],
);

import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, id, oneOf, tstz, userId } from "./users";
import { assignments } from "./work";

export const COURSE_COLORS = ["butter", "mint", "sky", "blush"] as const;
/**
 * AI help on assignments, per course (M2-27). "unknown" (she has not said) counts as "off";
 * read it through `assignmentHelp` in src/lib/ai-policy.ts.
 */
export const AI_ASSIGNMENTS = ["unknown", "off", "explain", "allowed"] as const;
/** May the course's study material (slides, handouts) go to an AI model? Read it through `studyAllowed`. */
export const AI_STUDY = ["unknown", "allowed", "not_allowed"] as const;
export const TEXT_STATUSES = ["none", "queued", "done", "failed"] as const;

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const courses = pgTable(
  "courses",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    moodleId: integer("moodle_id").notNull(),
    code: text("code"),
    name: text("name").notNull(),
    shortName: text("short_name"),
    color: text("color", { enum: COURSE_COLORS }).notNull().default("butter"),
    target: integer("target").notNull().default(5),
    aiAssignments: text("ai_assignments", { enum: AI_ASSIGNMENTS }).notNull().default("unknown"),
    aiStudy: text("ai_study", { enum: AI_STUDY }).notNull().default("unknown"),
    hidden: boolean("hidden").notNull().default(false),
  },
  (t) => [
    index("courses_user_id_idx").on(t.userId),
    unique("courses_user_moodle_key").on(t.userId, t.moodleId),
    oneOf("courses_color_check", t.color, COURSE_COLORS),
    oneOf("courses_ai_assignments_check", t.aiAssignments, AI_ASSIGNMENTS),
    oneOf("courses_ai_study_check", t.aiStudy, AI_STUDY),
  ],
);

export const courseFiles = pgTable(
  "course_files",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    assignmentId: uuid("assignment_id").references((): AnyPgColumn => assignments.id, {
      onDelete: "set null",
    }),
    moodleRef: text("moodle_ref").notNull(),
    section: text("section"),
    name: text("name").notNull(),
    mime: text("mime"),
    size: integer("size"),
    url: text("url").notNull(),
    modifiedAt: tstz("modified_at"),
    textStatus: text("text_status", { enum: TEXT_STATUSES }).notNull().default("none"),
  },
  (t) => [
    index("course_files_user_id_idx").on(t.userId),
    index("course_files_course_id_idx").on(t.courseId),
    unique("course_files_user_moodle_ref_key").on(t.userId, t.moodleRef),
    oneOf("course_files_text_status_check", t.textStatus, TEXT_STATUSES),
  ],
);

/** Extracted text, one row per page; `tsv` feeds Postgres full-text search. */
export const filePages = pgTable(
  "file_pages",
  {
    id: id(),
    createdAt: createdAt(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => courseFiles.id, { onDelete: "cascade" }),
    page: integer("page").notNull(),
    text: text("text").notNull().default(""),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('simple', coalesce("text", ''))`),
  },
  (t) => [
    unique("file_pages_file_page_key").on(t.fileId, t.page),
    index("file_pages_tsv_idx").using("gin", t.tsv),
  ],
);

import { index, integer, numeric, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { courses } from "./courses";
import { createdAt, id, oneOf, tstz, userId } from "./users";

export const WEIGHT_SOURCES = ["moodle", "manual"] as const;

export const gradeItems = pgTable(
  "grade_items",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    moodleRef: text("moodle_ref").notNull(),
    name: text("name").notNull(),
    short: text("short"),
    weight: numeric("weight", { mode: "number" }),
    /** null until a weight is known. */
    weightSource: text("weight_source", { enum: WEIGHT_SOURCES }),
    max: numeric("max", { mode: "number" }).notNull(),
    score: numeric("score", { mode: "number" }),
    gradedAt: tstz("graded_at"),
    dueText: text("due_text"),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("grade_items_user_id_idx").on(t.userId),
    index("grade_items_course_id_idx").on(t.courseId),
    unique("grade_items_user_moodle_ref_key").on(t.userId, t.moodleRef),
    oneOf("grade_items_weight_source_check", t.weightSource, WEIGHT_SOURCES),
  ],
);

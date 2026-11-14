import { index, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { courses } from "./courses";
import { createdAt, id, oneOf, tstz, userId } from "./users";

export const EVENT_KINDS = ["deadline", "exam", "quiz", "other"] as const;
export const EVENT_SOURCES = ["moodle", "manual"] as const;

export const events = pgTable(
  "events",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    courseId: uuid("course_id").references(() => courses.id, { onDelete: "set null" }),
    kind: text("kind", { enum: EVENT_KINDS }).notNull(),
    title: text("title").notNull(),
    startsAt: tstz("starts_at").notNull(),
    source: text("source", { enum: EVENT_SOURCES }).notNull(),
    moodleRef: text("moodle_ref"),
  },
  (t) => [
    index("events_user_id_idx").on(t.userId),
    index("events_course_id_idx").on(t.courseId),
    oneOf("events_kind_check", t.kind, EVENT_KINDS),
    oneOf("events_source_check", t.source, EVENT_SOURCES),
  ],
);

export const calendarFeeds = pgTable(
  "calendar_feeds",
  {
    id: id(),
    createdAt: createdAt(),
    // The unique constraint is also the user_id index.
    userId: userId().unique(),
    tokenHash: text("token_hash").notNull().unique(),
    provider: text("provider"),
  },
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    endpoint: text("endpoint").notNull().unique(),
    keys: jsonb("keys").$type<{ p256dh: string; auth: string }>().notNull(),
  },
  (t) => [index("push_subscriptions_user_id_idx").on(t.userId)],
);

export const reminderLog = pgTable(
  "reminder_log",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    ref: text("ref").notNull(),
    kind: text("kind").notNull(),
    sentAt: tstz("sent_at").notNull().defaultNow(),
  },
  (t) => [
    index("reminder_log_user_id_idx").on(t.userId),
    unique("reminder_log_user_ref_kind_key").on(t.userId, t.ref, t.kind),
  ],
);

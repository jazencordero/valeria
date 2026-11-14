import { boolean, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, oneOf, tstz, userId, users } from "./users";

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    createdAt: createdAt(),
    kind: text("kind").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    payload: jsonb("payload").notNull().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    runAfter: tstz("run_after").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [
    index("jobs_user_id_idx").on(t.userId),
    index("jobs_status_run_after_idx").on(t.status, t.runAfter),
    oneOf("jobs_status_check", t.status, JOB_STATUSES),
  ],
);

export const aiCache = pgTable("ai_cache", {
  id: id(),
  createdAt: createdAt(),
  hash: text("hash").notNull().unique(),
  job: text("job").notNull(),
  model: text("model").notNull(),
  output: jsonb("output").notNull(),
});

/** Provider metrics; a deleted user's rows stay, with user_id set to null. */
export const aiCalls = pgTable(
  "ai_calls",
  {
    id: id(),
    createdAt: createdAt(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    job: text("job").notNull(),
    ok: boolean("ok").notNull(),
    ms: integer("ms").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("ai_calls_user_id_idx").on(t.userId),
    index("ai_calls_created_at_idx").on(t.createdAt),
  ],
);

export const providerCooldowns = pgTable("provider_cooldowns", {
  id: id(),
  createdAt: createdAt(),
  provider: text("provider").notNull().unique(),
  until: tstz("until").notNull(),
});

/** The three success signals (M8-28). */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    kind: text("kind").notNull(),
    at: tstz("at").notNull().defaultNow(),
    ms: integer("ms"),
  },
  (t) => [
    index("usage_events_user_id_idx").on(t.userId),
    index("usage_events_kind_at_idx").on(t.kind, t.at),
  ],
);

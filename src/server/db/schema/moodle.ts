import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, id, oneOf, tstz, userId } from "./users";

export const MOODLE_STATUSES = ["ok", "expired", "revoked", "error"] as const;

export const moodleConnections = pgTable(
  "moodle_connections",
  {
    id: id(),
    createdAt: createdAt(),
    // The unique constraint is also the user_id index.
    userId: userId().unique(),
    siteUrl: text("site_url").notNull(),
    moodleUserId: integer("moodle_user_id").notNull(),
    /** AES-256-GCM sealed; only the key module opens it. */
    tokenSealed: text("token_sealed").notNull(),
    privateTokenSealed: text("private_token_sealed"),
    functions: jsonb("functions").$type<string[]>().notNull().default([]),
    status: text("status", { enum: MOODLE_STATUSES }).notNull().default("ok"),
    connectedAt: tstz("connected_at").notNull().defaultNow(),
    lastSyncAt: tstz("last_sync_at"),
    lastError: text("last_error"),
  },
  (t) => [
    oneOf("moodle_connections_status_check", t.status, MOODLE_STATUSES),
  ],
);

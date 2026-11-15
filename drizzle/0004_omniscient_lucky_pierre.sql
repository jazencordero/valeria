CREATE TABLE "tutor_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"note_id" uuid,
	"anchor_kind" text NOT NULL,
	"anchor_id" uuid,
	"quote" text,
	"role" text NOT NULL,
	"body" text NOT NULL,
	"reply_to" uuid,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"tokens_estimated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "tutor_messages_anchor_kind_check" CHECK ("tutor_messages"."anchor_kind" in ('lecture', 'exam', 'card', 'general')),
	CONSTRAINT "tutor_messages_role_check" CHECK ("tutor_messages"."role" in ('user', 'assistant'))
);
--> statement-breakpoint
ALTER TABLE "tutor_messages" ADD CONSTRAINT "tutor_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_messages" ADD CONSTRAINT "tutor_messages_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_messages" ADD CONSTRAINT "tutor_messages_reply_to_tutor_messages_id_fk" FOREIGN KEY ("reply_to") REFERENCES "public"."tutor_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tutor_messages_user_id_created_at_idx" ON "tutor_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "tutor_messages_note_id_idx" ON "tutor_messages" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "tutor_messages_created_at_idx" ON "tutor_messages" USING btree ("created_at");
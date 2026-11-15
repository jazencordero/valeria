CREATE TABLE "exam_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"exam_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "exam_documents_exam_slug_key" UNIQUE("exam_id","slug")
);
--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "import_id" text;--> statement-breakpoint
ALTER TABLE "concepts" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "study_map" jsonb;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "start_new_on" date;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "grade_target" jsonb;--> statement-breakpoint
ALTER TABLE "exam_documents" ADD CONSTRAINT "exam_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_documents" ADD CONSTRAINT "exam_documents_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exam_documents_user_id_idx" ON "exam_documents" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_user_exam_import_id_key" UNIQUE("user_id","exam_id","import_id");
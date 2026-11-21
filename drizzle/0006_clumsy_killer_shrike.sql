CREATE TABLE "mock_exam_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"mock_exam_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"seconds_used" integer DEFAULT 0 NOT NULL,
	"tf_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"true_false" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"texts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ticks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"score" jsonb,
	"total" numeric
);
--> statement-breakpoint
CREATE TABLE "mock_exams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"import_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"content" jsonb NOT NULL,
	"lecture_pages" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "mock_exams_user_import_id_key" UNIQUE("user_id","import_id")
);
--> statement-breakpoint
ALTER TABLE "mock_exam_attempts" ADD CONSTRAINT "mock_exam_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_exam_attempts" ADD CONSTRAINT "mock_exam_attempts_mock_exam_id_mock_exams_id_fk" FOREIGN KEY ("mock_exam_id") REFERENCES "public"."mock_exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_exams" ADD CONSTRAINT "mock_exams_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_exams" ADD CONSTRAINT "mock_exams_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mock_exam_attempts_user_id_idx" ON "mock_exam_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mock_exam_attempts_mock_exam_id_idx" ON "mock_exam_attempts" USING btree ("mock_exam_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mock_exam_attempts_one_open_key" ON "mock_exam_attempts" USING btree ("mock_exam_id") WHERE finished_at is null;--> statement-breakpoint
CREATE INDEX "mock_exams_user_id_idx" ON "mock_exams" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mock_exams_course_id_idx" ON "mock_exams" USING btree ("course_id");
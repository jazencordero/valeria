ALTER TABLE "courses" DROP CONSTRAINT "courses_ai_policy_check";--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "ai_assignments" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "ai_study" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
-- M2-27, written by hand: carry the old value over before the column goes.
-- allowed -> allowed + allowed; not_allowed -> explain + not_allowed; unknown -> unknown + unknown.
UPDATE "courses" SET
  "ai_assignments" = CASE "ai_policy" WHEN 'allowed' THEN 'allowed' WHEN 'not_allowed' THEN 'explain' ELSE 'unknown' END,
  "ai_study" = CASE "ai_policy" WHEN 'allowed' THEN 'allowed' WHEN 'not_allowed' THEN 'not_allowed' ELSE 'unknown' END;--> statement-breakpoint
ALTER TABLE "courses" DROP COLUMN "ai_policy";--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_ai_assignments_check" CHECK ("courses"."ai_assignments" in ('unknown', 'off', 'explain', 'allowed'));--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_ai_study_check" CHECK ("courses"."ai_study" in ('unknown', 'allowed', 'not_allowed'));
/*
 * How long an assignment takes (M2-12): one number from the small model.
 *
 *   const minutes = await estimateMinutes({ brief, attachments });   // 15..600 in steps of 15, or null
 *   await drain(ESTIMATE_KIND, estimateJob({ tally }), { ... });      // src/app/api/cron/estimate
 *
 * `estimateMinutes` sends the brief (the assignment's intro as plain text, cut at BRIEF_MAX
 * characters) and the names of the files attached to it, and asks for the minutes a prepared
 * student needs. The reply is read strictly (`parseMinutes`): the first whole number in it,
 * rounded to the nearest 15 and held to 15..600. A reply with no number gives null. The answer
 * is cached (../cache) under a hash of the brief text plus the sorted attachment names, so the
 * same brief is never asked twice; a null answer is cached too, so a model that will not give a
 * number is not asked again on every sync.
 *
 * `estimateJob` is the handler for one `estimate` job, payload `{ assignmentId }`, added for
 * each assignment with no estimate at the end of a finished sync (../../sync/run.ts). It writes
 * `assignments.estimate_min`. It ends the job without asking anything when the assignment is
 * gone, already has an estimate, has no brief and no files, or when AI help on its course's
 * assignments is off.
 *
 * Aalto's rules (context/moodle/terms.md, point d): a teacher's material may go to an outside
 * AI model only where the course allows it. The brief is the teacher's material, so it is sent
 * only when `assignmentHelp` (src/lib/ai-policy.ts, M2-27) is 'allowed'. 'explain' is skipped
 * too (build-ai's call, stricter than the ticket: courses carried over from 'not_allowed' become
 * 'explain', and their teachers' briefs must not start going to an outside model). 'off' and
 * 'unknown' (the default, which counts as off) are skipped and keep `estimate_min` null; the screens already hide a missing
 * estimate.
 *
 * Errors: `AiBusy` (every free provider is limited or down) is thrown, so the queue tries the job
 * again later with its backoff. A reply with no number is not an error: the job ends done and the
 * estimate stays null. Nothing here logs; the brief, the prompt and the reply are never logged.
 */
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { assignmentHelp } from "@/lib/ai-policy";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { assignments } from "@/server/db/schema/work";
import type { JobHandler } from "@/server/jobs/queue";
import { cached } from "../cache";
import { runText as defaultRunText, type RunInput, type RunTextResult } from "../router";

/** The job kind; the tick calls /api/cron/estimate when one is due. */
export const ESTIMATE_KIND = "estimate";
/** Stored in `ai_calls.job` and used as the cache job name. */
export const ESTIMATE_AI_JOB = "estimate-minutes";

export const MIN_MINUTES = 15;
export const MAX_MINUTES = 600;
export const STEP_MINUTES = 15;
/** Characters of brief sent; the start of a brief says what the work is. */
export const BRIEF_MAX = 6_000;
/** Attachment names sent at most. */
export const ATTACHMENTS_MAX = 30;

const SYSTEM =
  "You estimate study workload. Read the assignment brief and the names of its attached files. " +
  "Reply with one whole number only: the minutes a prepared student needs to finish this assignment. " +
  "No words, no range, no units.";

export type EstimateInput = {
  /** The brief as plain text. */
  brief: string;
  /** Names of the files attached to the assignment. */
  attachments: string[];
};

export type EstimateDeps = {
  runText?: (input: RunInput) => Promise<RunTextResult>;
  db?: Db;
  userId?: string | null;
};

/** The first whole number in `reply`, rounded to the nearest 15 and held to 15..600; null if there is none. */
export function parseMinutes(reply: string): number | null {
  const match = /\d+/.exec(reply);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isFinite(n)) return MAX_MINUTES;
  const rounded = Math.round(n / STEP_MINUTES) * STEP_MINUTES;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, rounded));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The intro HTML as plain text: tags dropped, common entities decoded, white space collapsed. */
export function briefText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === "#") {
        const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** What the cache key is made of: a hash of the brief text and the sorted attachment names. */
export function estimateHash({ brief, attachments }: EstimateInput): string {
  const names = [...attachments].sort();
  return createHash("sha256").update(JSON.stringify([brief, names])).digest("hex");
}

function prompt({ brief, attachments }: EstimateInput): string {
  const names = attachments.slice(0, ATTACHMENTS_MAX);
  const parts = [`Assignment brief:\n${brief ? brief.slice(0, BRIEF_MAX) : "(none)"}`];
  parts.push(`Attached files: ${names.length ? names.join(", ") : "(none)"}`);
  return parts.join("\n\n");
}

/**
 * Minutes a prepared student needs, from the small model: 15..600 in steps of 15, or null when
 * the model gave no number. Throws `AiBusy` when no free provider can answer.
 */
export async function estimateMinutes(assignment: EstimateInput, deps: EstimateDeps = {}): Promise<number | null> {
  const runText = deps.runText ?? defaultRunText;
  const out = await cached(
    ESTIMATE_AI_JOB,
    { hash: estimateHash(assignment) },
    async () => {
      const { text } = await runText({
        size: "small",
        system: SYSTEM,
        messages: [{ role: "user", content: prompt(assignment) }],
        job: ESTIMATE_AI_JOB,
        userId: deps.userId ?? null,
      });
      return { minutes: parseMinutes(text) };
    },
    { model: "small", database: deps.db ?? defaultDb },
  );
  return out.minutes;
}

/** What the finished `estimate` jobs of one drain did. */
export type EstimateTally = {
  /** An estimate was written. */
  estimated: number;
  /** Ended without asking the model: gone, already estimated, nothing to read, or AI not allowed. */
  skipped: number;
  /** The model answered without a number; the estimate stays null. */
  noNumber: number;
};

export type EstimatePayload = { assignmentId?: unknown };

/** The handler for one `estimate` job. Safe to run twice for the same assignment. */
export function estimateJob(
  options: { tally?: EstimateTally; db?: Db; runText?: EstimateDeps["runText"] } = {},
): JobHandler<EstimatePayload> {
  const tally = options.tally ?? { estimated: 0, skipped: 0, noNumber: 0 };
  return async (payload) => {
    const db = options.db ?? defaultDb;
    const assignmentId = typeof payload.assignmentId === "string" ? payload.assignmentId : null;
    if (!assignmentId) {
      tally.skipped += 1;
      return;
    }

    const [row] = await db
      .select({
        userId: assignments.userId,
        introHtml: assignments.introHtml,
        estimateMin: assignments.estimateMin,
        aiAssignments: courses.aiAssignments,
      })
      .from(assignments)
      .innerJoin(courses, eq(courses.id, assignments.courseId))
      .where(eq(assignments.id, assignmentId))
      .limit(1);
    // The brief goes to an outside model only where AI help on assignments is allowed (terms.md, d).
    if (!row || row.estimateMin !== null || assignmentHelp(row) !== "allowed") {
      tally.skipped += 1;
      return;
    }

    const files = await db
      .select({ name: courseFiles.name })
      .from(courseFiles)
      .where(eq(courseFiles.assignmentId, assignmentId))
      .orderBy(courseFiles.name);
    const input: EstimateInput = { brief: briefText(row.introHtml), attachments: files.map((f) => f.name) };
    if (!input.brief && input.attachments.length === 0) {
      tally.skipped += 1;
      return;
    }

    const minutes = await estimateMinutes(input, { runText: options.runText, db, userId: row.userId });
    if (minutes === null) {
      tally.noNumber += 1;
      return;
    }
    // Only fills an empty estimate, so a run that finishes late never overwrites a newer one.
    await db
      .update(assignments)
      .set({ estimateMin: minutes })
      .where(and(eq(assignments.id, assignmentId), isNull(assignments.estimateMin)));
    tally.estimated += 1;
  };
}

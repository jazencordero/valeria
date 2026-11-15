import { and, count, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { aiRoute } from "@/server/ai/doorway";
import { db } from "@/server/db/client";
import { aiCalls } from "@/server/db/schema/system";
import {
  ANSWER_MAX_TOKENS,
  buildCopyPrompt,
  buildTutorContext,
  HISTORY_MAX_CHARS,
  HISTORY_MESSAGES,
  MESSAGE_MAX_CHARS,
  TUTOR_RESTING,
  tutorEnabled,
  whereSchema,
} from "@/server/tutor/context";

/*
 * M2-28: the tutor. POST `{ text, where, history? }`, answered as the AI SDK's UI message stream
 * (server-sent events), which the drawer (src/components/tutor/tutor.tsx) reads.
 * POST `{ mode: "copy", text, where }`: the "Copy for Claude" text as JSON `{ text, note }`. No
 * AI call, nothing sent anywhere: the drawer puts it on her clipboard.
 *
 * In order (after aiRoute's sign-in, hourly and body checks):
 * 1. The tutor must be switched on for her account (`users.settings.tutor.enabled === true`).
 *    Otherwise 404 `{error:'not_found'}`, the same answer as any id that is not hers, so the
 *    answer says nothing about a feature existing.
 * 2. Copy mode: the prompt from `buildCopyPrompt`, done.
 * 3. Abuse guard: 30 tutor calls a minute (rows in `ai_calls`, one per provider attempt): 429
 *    `{error:'slow_down'}`. There is no daily cap (Jazen, 2026-11-15); aiRoute's hourly count is
 *    set to 1,800 so it never acts as one.
 * 4. The context is built on the server from where she is (src/server/tutor/context.ts).
 * 5. The last 20 messages (her history, cut to HISTORY_MAX_CHARS, plus this one) go to the
 *    large size with `paid: "tutor"`: Claude first when ANTHROPIC_API_KEY is set, the free
 *    providers otherwise or when it fails before answering (src/server/ai/router.ts). Answers
 *    are capped at 1,500 output tokens.
 * 6. Every provider busy: 503 `{error:'tutor_resting', message: TUTOR_RESTING}`. The drawer
 *    shows that line and keeps her text in the box.
 *
 * Storage seam (M2-28 stopped here): tutor chats are meant to be kept like assignment chats (the
 * M2-11 store, kind `tutor`). The `chats` table has no `kind` column and its `assignment_id` is
 * NOT NULL and unique (src/server/db/schema/work.ts), so a tutor chat cannot be stored without a
 * schema change, which needs its own decision. Until then the drawer holds the chat and sends
 * the history with each message (cut here again, so a long one cannot blow the budget), and
 * `storeTurn` below is where storing goes.
 *
 * Nothing here logs her text, the context or the answer.
 */

const PER_MINUTE = 30;
const MINUTE_MS = 60_000;
/** The fixed sentence the browser gets when the stream fails part-way. */
const STREAM_ERROR_TEXT = "The answer stopped early. Try again.";

const Turn = z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(MESSAGE_MAX_CHARS * 2) });

const Body = z.object({
  mode: z.enum(["chat", "copy"]).optional(),
  text: z.string().max(MESSAGE_MAX_CHARS),
  where: whereSchema,
  history: z.array(Turn).max(100).optional(),
});

type Turn = z.infer<typeof Turn>;
type Message = { role: "user" | "assistant"; content: string };

/** Her history plus this message: the newest HISTORY_MESSAGES that fit, starting with hers. */
function historyFor(history: Turn[], text: string): Message[] {
  const out: Message[] = [{ role: "user", content: text }];
  let used = 0;
  for (const turn of history.slice(-(HISTORY_MESSAGES - 1)).reverse()) {
    const content = turn.text.trim();
    if (!content) continue;
    if (used + content.length > HISTORY_MAX_CHARS) break;
    used += content.length;
    out.unshift({ role: turn.role, content });
  }
  while (out.length > 1 && out[0].role !== "user") out.shift();
  return out;
}

async function tutorCallsLastMinute(userId: string): Promise<number> {
  const since = new Date(Date.now() - MINUTE_MS);
  const [row] = await db
    .select({ n: count() })
    .from(aiCalls)
    .where(and(eq(aiCalls.userId, userId), eq(aiCalls.job, "tutor"), gt(aiCalls.createdAt, since)));
  return row?.n ?? 0;
}

/** Storage seam: where a finished turn will be stored once tutor chats have a table. */
async function storeTurn(): Promise<void> {
  // Intentionally empty until the chats schema can hold a tutor chat (see the header).
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export const POST = aiRoute(
  async ({ body, user, ai }) => {
    if (!tutorEnabled(user.settings)) return json(404, { error: "not_found" });

    if (body.mode === "copy") {
      const copy = await buildCopyPrompt(user.id, body.where, body.text);
      return json(200, { text: copy.text, note: copy.note });
    }

    const text = body.text.trim();
    if (!text) return json(400, { error: "bad_request", issues: [{ path: "text", message: "Empty message." }] });
    if ((await tutorCallsLastMinute(user.id)) >= PER_MINUTE) return json(429, { error: "slow_down" });

    const history = body.history ?? [];
    const context = await buildTutorContext(user.id, body.where, {
      firstAnswer: !history.some((turn) => turn.role === "assistant"),
    });

    let stream;
    try {
      stream = await ai.streamChat({
        systemParts: context.parts,
        messages: historyFor(history, text),
        job: "tutor",
        paid: "tutor",
        maxOutputTokens: ANSWER_MAX_TOKENS,
        onEnd: storeTurn,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AiBusy") {
        return json(503, { error: "tutor_resting", message: TUTOR_RESTING });
      }
      throw error;
    }
    const { result } = stream;
    void result.consumeStream({ onError: () => {} });
    return result.toUIMessageStreamResponse({
      headers: { "cache-control": "no-store" },
      onError: () => STREAM_ERROR_TEXT,
    });
  },
  { size: "large", perUserPerHour: 1800, body: Body },
);

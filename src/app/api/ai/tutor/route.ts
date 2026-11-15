import { and, count, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { aiRoute } from "@/server/ai/doorway";
import { db } from "@/server/db/client";
import { aiCalls } from "@/server/db/schema/system";
import { claudeAllowed } from "@/server/tutor/budget";
import {
  ANSWER_MAX_TOKENS,
  buildCopyPrompt,
  buildTutorContext,
  MESSAGE_MAX_CHARS,
  TUTOR_RESTING,
  tutorAnchor,
  tutorEnabled,
  whereSchema,
} from "@/server/tutor/context";
import {
  appendAnswerToNote,
  hasAnswer,
  loadChat,
  ownAnswer,
  ownNote,
  recentTurns,
  storeTurn,
  type ChatKey,
  type TokenCounts,
} from "@/server/tutor/store";

/*
 * M2-28: the tutor. One POST route, four modes (all after aiRoute's sign-in, hourly and body
 * checks, and all 404 `{error:'not_found'}` unless the tutor is switched on for her account,
 * `users.settings.tutor.enabled === true`; the same answer as any id that is not hers):
 *
 * chat (default) `{ text, where, noteId?, quote? }`
 *   Her question, answered as the AI SDK's UI message stream (server-sent events). The chat is
 *   the note's (`noteId`, hers) or, without a note, the place's anchor (lecture, exam, card or
 *   general, from `where`). `quote` is the passage she highlighted (default: the note's quote);
 *   src/server/tutor/context.ts decides whether it is course text. History = the last 8 stored
 *   messages of that chat, never what the client sends (`history` is accepted and ignored, so
 *   the step-1 drawer keeps working). Her message and the answer are stored when the answer has
 *   streamed whole, with the model and the token counts (the provider's usage, else characters
 *   / 4, marked estimated).
 *   The stream's `start` chunk carries `messageMetadata: { model, questionId, answerId, deeper }`
 *   (`model` is "provider:model", for the small line under the answer); the same model is in the
 *   `x-tutor-model` header.
 * chat with `{ deeper: true, answerId, where, noteId? }`
 *   "Go deeper": the question that answer belongs to is asked again on the large Claude model
 *   (the only way to it), with the history before that question. The new answer is stored under
 *   the same question. 409 `{error:'deeper_unavailable'}` when there is no key or no budget left.
 * load `{ mode: "load", where, noteId? }` -> `{ messages, deeperAvailable }`
 *   The stored chat, oldest first (each question followed by its answers). No AI call.
 * copy `{ mode: "copy", text, where }` -> `{ text, note }`
 *   The "Copy for Claude" text. No AI call, nothing sent anywhere.
 * save `{ mode: "save", noteId, answerId }` -> `{ ok: true, body }`
 *   "Save to note": that answer appended to the note's body.
 *
 * Claude or not: with ANTHROPIC_API_KEY set and this month's tutor spend under
 * TUTOR_BUDGET_EUR (src/server/tutor/budget.ts) the router tries Claude first; otherwise it is
 * not asked at all and the free providers answer.
 * Abuse guard: 30 tutor calls a minute (rows in `ai_calls`, one per provider attempt): 429
 * `{error:'slow_down'}`. No daily cap (Jazen, 2026-11-15); aiRoute's hourly count is 1,800.
 * Every provider busy: 503 `{error:'tutor_resting', message: TUTOR_RESTING}`.
 *
 * Nothing here logs her text, the context or the answer.
 */

const PER_MINUTE = 30;
const MINUTE_MS = 60_000;
/** The fixed sentence the browser gets when the stream fails part-way. */
const STREAM_ERROR_TEXT = "The answer stopped early. Try again.";

const Turn = z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(MESSAGE_MAX_CHARS * 2) });

const Body = z.object({
  mode: z.enum(["chat", "copy", "load", "save"]).optional(),
  text: z.string().max(MESSAGE_MAX_CHARS).optional(),
  where: whereSchema.optional(),
  noteId: z.uuid().optional(),
  quote: z.string().max(MESSAGE_MAX_CHARS).optional(),
  deeper: z.boolean().optional(),
  answerId: z.uuid().optional(),
  /** Sent by the step-1 drawer; ignored (history comes from storage). */
  history: z.array(Turn).max(100).optional(),
});

async function tutorCallsLastMinute(userId: string): Promise<number> {
  const since = new Date(Date.now() - MINUTE_MS);
  const [row] = await db
    .select({ n: count() })
    .from(aiCalls)
    .where(and(eq(aiCalls.userId, userId), eq(aiCalls.job, "tutor"), gt(aiCalls.createdAt, since)));
  return row?.n ?? 0;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

const bad = (path: string, message: string) => json(400, { error: "bad_request", issues: [{ path, message }] });
const notFound = () => json(404, { error: "not_found" });

/** Characters / 4: the estimate when a provider reports no usage. */
const estimate = (chars: number) => Math.ceil(chars / 4);

export const POST = aiRoute(
  async ({ body, user, ai }) => {
    if (!tutorEnabled(user.settings)) return notFound();
    const mode = body.mode ?? "chat";

    const note = body.noteId ? await ownNote(user.id, body.noteId) : null;
    if (body.noteId && !note) return notFound();

    if (mode === "save") {
      if (!note || !body.answerId) return bad(note ? "answerId" : "noteId", "Required.");
      const saved = await appendAnswerToNote(user.id, note.id, body.answerId);
      return saved === null ? notFound() : json(200, { ok: true, body: saved });
    }

    const where = body.where;
    if (!where) return bad("where", "Required.");

    if (mode === "copy") {
      const copy = await buildCopyPrompt(user.id, where, body.text ?? "");
      return json(200, { text: copy.text, note: copy.note });
    }

    const anchor = await tutorAnchor(user.id, where);
    const placeKey: ChatKey = note ? { noteId: note.id, anchor } : { noteId: null, anchor };

    if (mode === "load") {
      const messages = await loadChat(user.id, placeKey);
      return json(200, {
        messages: messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
        deeperAvailable: await claudeAllowed(),
      });
    }

    // chat
    const deeper = body.deeper === true;
    const earlier = deeper ? (body.answerId ? await ownAnswer(user.id, body.answerId) : undefined) : null;
    if (deeper && earlier === undefined) return bad("answerId", "Required.");
    if (deeper && !earlier?.question) return notFound();
    const text = deeper ? earlier!.question!.text : (body.text ?? "").trim();
    if (!text) return bad("text", "Empty message.");
    if ((await tutorCallsLastMinute(user.id)) >= PER_MINUTE) return json(429, { error: "slow_down" });

    const paidOk = await claudeAllowed();
    if (deeper && !paidOk) return json(409, { error: "deeper_unavailable" });

    const key = deeper ? earlier!.key : placeKey;
    const quote = deeper ? earlier!.question!.quote : (body.quote ?? note?.quote ?? null);
    const context = await buildTutorContext(user.id, where, { firstAnswer: !(await hasAnswer(user.id, key)), quote });
    const history = await recentTurns(user.id, key, { before: deeper ? earlier!.question!.createdAt : undefined });
    const messages = [...history, { role: "user" as const, content: text }];

    const questionId = deeper ? earlier!.question!.id : crypto.randomUUID();
    const answerId = crypto.randomUUID();
    const promptChars = context.parts.reduce((n, p) => n + p.text.length, 0) + messages.reduce((n, m) => n + m.content.length, 0);

    // The model is known once a provider has answered; onEnd runs after that.
    let setModel!: (model: string | null) => void;
    const answeredBy = new Promise<string | null>((resolve) => (setModel = resolve));

    let stream;
    try {
      stream = await ai.streamChat({
        systemParts: context.parts,
        messages,
        job: "tutor",
        ...(paidOk ? { paid: "tutor" as const } : {}),
        ...(deeper ? { deeper: true } : {}),
        maxOutputTokens: ANSWER_MAX_TOKENS,
        onEnd: async ({ text: answer, usage }) => {
          const model = await answeredBy;
          if (!model || !answer.trim()) return;
          const tokens: TokenCounts = usage
            ? { ...usage, estimated: false }
            : { input: estimate(promptChars), output: estimate(answer.length), cacheRead: 0, cacheWrite: 0, estimated: true };
          try {
            await storeTurn({
              userId: user.id,
              key,
              question: deeper ? null : { id: questionId, text, quote: context.quote?.text ?? null },
              replyTo: questionId,
              answer: { id: answerId, text: answer, model, tokens },
            });
          } catch {
            console.warn("tutor: could not store a turn");
          }
        },
      });
    } catch (error) {
      setModel(null);
      if (error instanceof Error && error.name === "AiBusy") {
        return json(503, { error: "tutor_resting", message: TUTOR_RESTING });
      }
      throw error;
    }
    const model = `${stream.provider}:${stream.model}`;
    setModel(model);
    const { result } = stream;
    void result.consumeStream({ onError: () => {} });
    return result.toUIMessageStreamResponse({
      headers: { "cache-control": "no-store", "x-tutor-model": model },
      messageMetadata: ({ part }) => (part.type === "start" ? { model, questionId, answerId, deeper } : undefined),
      onError: () => STREAM_ERROR_TEXT,
    });
  },
  { size: "large", perUserPerHour: 1800, body: Body },
);

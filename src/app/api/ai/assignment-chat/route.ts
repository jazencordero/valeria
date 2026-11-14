import { z } from "zod";
import { aiRoute } from "@/server/ai/doorway";
import { HISTORY_BUDGET_CHARS, READ_PAGES_MAX, buildContext, type ChatTools } from "@/server/chat/context";
import {
  ChatNotFound,
  appendMessage,
  getOrCreateChat,
  listMessages,
  type ChatMessage,
  type ChatPart,
} from "@/server/chat/store";

/*
 * M2-14: the assignment chat. POST `{ assignmentId, text }`, answered as the AI SDK's UI message
 * stream (server-sent events), which `useChat` reads.
 *
 * In order:
 * 1. The assignment must be hers. One that is not, or does not exist: 404 `{error:'not_found'}`
 *    and nothing is stored.
 * 2. Her message is stored.
 * 3. The context is built again on every request (the course's AI policy can change mid-chat).
 * 4. The last 20 messages, cut to the history budget, go to the large model. Where the course
 *    allows AI the model may call `search_material`, `read_pages` and `write_draft` (M2-19),
 *    for up to 4 rounds.
 * 5. When the reply has streamed to its end, ONE assistant message is stored: its text, plus a
 *    `source` part for each different `[file, p. N]` in it, plus one `draft` part if
 *    `write_draft` saved a draft during this request. There is one draft per assignment, so
 *    two calls in one request still give one part, and the draft holds the later text.
 *
 * What is stored when things go wrong:
 * - Every provider busy before the stream starts: the doorway answers 503 with the busy
 *   message. Her message stays stored; nothing is stored for the assistant.
 * - The stream fails part-way (a provider error after the first words, or between tool rounds):
 *   the browser gets an `error` part with a fixed sentence, and nothing is stored for the
 *   assistant. Half an answer is never kept. Her message stays, so she can ask again.
 * - The model ends without any text (it used all its rounds on tools): nothing is stored,
 *   unless it saved a draft: then the message is the `draft` part alone, so the card shows.
 * - A draft was saved and the stream then failed: the draft stays saved (the latest wins), but
 *   no message points at it. She can ask again.
 * - She closes the tab mid-reply: the reply is still read to its end here and stored.
 *
 * One request is one row in `ai_calls` however many tool rounds it takes, so "40 an hour" counts
 * her messages (plus one per provider that was tried and failed).
 *
 * Nothing here logs her text, the brief or the reply.
 */

const MAX_TEXT_CHARS = 4000;
const HISTORY_MESSAGES = 20;
const TOOL_ROUNDS = 4;
/** The fixed sentence the browser gets when the stream fails. Never the provider's own error. */
const STREAM_ERROR_TEXT = "The answer stopped early. Try again.";
/**
 * Tool answers share the history budget (see the budget note in chat/context.ts). One
 * `read_pages` answer holds up to READ_PAGES_MAX characters of text plus its JSON wrapping.
 */
const TOOL_RESULT_RESERVE_CHARS = TOOL_ROUNDS * (READ_PAGES_MAX + 500);

const Body = z.object({
  assignmentId: z.uuid(),
  text: z.string().min(1).max(MAX_TEXT_CHARS),
});

type Turn = { role: "user" | "assistant"; content: string };

function textOf(message: ChatMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n")
    .trim();
}

/**
 * The newest `HISTORY_MESSAGES` messages that fit in `budget` characters, oldest first. Older
 * ones are dropped whole; the newest (her question) is always kept. Starts with one of hers.
 */
function historyFor(messages: ChatMessage[], budget: number): Turn[] {
  const turns: Turn[] = [];
  let used = 0;
  for (const message of messages.slice(-HISTORY_MESSAGES).reverse()) {
    const content = textOf(message);
    if (!content) continue;
    if (turns.length > 0 && used + content.length > budget) break;
    used += content.length;
    turns.unshift({ role: message.role, content });
  }
  while (turns.length > 1 && turns[0].role !== "user") turns.shift();
  return turns;
}

const CITATION = /\[([^[\]\n]{1,300}?,\s*p\.\s*\d+)\]/g;

/**
 * The reply as stored parts: the text, one `source` per different `[file, p. N]` in it, and the
 * draft saved in this request, if any. Empty when there is neither text nor a draft.
 */
function replyParts(text: string, draftId: string | undefined): ChatPart[] {
  const parts: ChatPart[] = [];
  if (text) {
    const labels = new Set<string>();
    for (const match of text.matchAll(CITATION)) labels.add(match[1].replace(/\s+/g, " ").trim());
    parts.push({ type: "text", text }, ...[...labels].map((label): ChatPart => ({ type: "source", label })));
  }
  if (draftId) parts.push({ type: "draft", draftId });
  return parts;
}

/** The same tools, with `write_draft` reporting the id of each draft it saves. */
function noticingDrafts(tools: ChatTools, onSaved: (draftId: string) => void): ChatTools {
  const write = tools.write_draft;
  if (!write) return tools;
  return {
    ...tools,
    write_draft: {
      ...write,
      async execute(input) {
        const output = await write.execute(input);
        if ("draftId" in output) onSaved(output.draftId);
        return output;
      },
    },
  };
}

export const POST = aiRoute(
  async ({ body, user, ai }) => {
    let chatId: string;
    try {
      chatId = (await getOrCreateChat(user.id, body.assignmentId)).id;
    } catch (error) {
      if (error instanceof ChatNotFound) return notFound();
      throw error;
    }
    await appendMessage(user.id, chatId, "user", [{ type: "text", text: body.text }]);

    let context;
    try {
      context = await buildContext(user.id, body.assignmentId);
    } catch (error) {
      if (error instanceof ChatNotFound) return notFound();
      throw error;
    }
    const hasTools = Object.keys(context.tools).length > 0;
    const budget = HISTORY_BUDGET_CHARS - (hasTools ? TOOL_RESULT_RESERVE_CHARS : 0);
    const messages = historyFor(await listMessages(user.id, chatId), budget);

    // The end of the stream can be reported more than once; the reply is stored once.
    let saved = false;
    // The draft `write_draft` saved in this request, if it did.
    let draftId: string | undefined;
    const tools = noticingDrafts(context.tools, (id) => {
      draftId = id;
    });
    const { result } = await ai.streamChat({
      system: context.system,
      messages,
      job: "assignment-chat",
      tools,
      maxToolRounds: TOOL_ROUNDS,
      onEnd: async ({ text }) => {
        if (saved) return;
        saved = true;
        const parts = replyParts(text.trim(), draftId);
        if (parts.length === 0) return;
        try {
          await appendMessage(user.id, chatId, "assistant", parts);
        } catch {
          // A database error can carry the row it tried to write, so it is not printed.
          console.error("assignment-chat: the reply could not be stored");
        }
      },
    });

    // Read the reply to its end even if she closes the tab, so it is stored either way.
    void result.consumeStream({ onError: () => {} });
    return result.toUIMessageStreamResponse({
      headers: { "cache-control": "no-store" },
      onError: () => STREAM_ERROR_TEXT,
    });
  },
  { size: "large", perUserPerHour: 40, body: Body },
);

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
}

// Fake OpenAI-compatible AI server for tests. Never talks to a real provider.
//
//   const ai = await startFakeAi();               // listens on 127.0.0.1, random free port
//   const baseUrl = `${ai.url}/groq/v1`;          // the first path segment is the "route"
//   ai.queue("groq", { status: 429, retryAfter: 30 });   // next request on /groq/... gets this, once
//   ai.queue("groq", { text: '{"ok":true}' });           // then this
//   ai.setDefault("openrouter", { text: "Hello there" }); // every request with an empty queue
//   ai.calls   // every request received: route, model, stream flag, whether a bearer key was sent, body
//   await ai.close();
//
// Every POST to a path ending in /chat/completions is answered. A reply is one of:
//   { text }                  a normal answer: JSON, or SSE chunks (one per word) when the request
//                             has `stream: true`. Use BROKEN_JSON as `text` for "broken JSON".
//   { status, retryAfter? }   an error status (429, 500, 503 ...) with an OpenAI-style error body;
//                             `retryAfter` (seconds or an HTTP date) becomes the retry-after header.
//   { rawBody, status? }      this exact body as application/json, e.g. a truncated response.
// Any reply may add `delayMs`. With no queued reply and no default, the answer is { text: "ok" }.
// Every response closes its connection, so a client never reuses a socket the server timed out.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Model content that is not valid JSON: the opening of an object, cut off. */
export const BROKEN_JSON = '{"title": "Cut off';

export type FakeReply =
  | { text: string; delayMs?: number }
  | { status: number; retryAfter?: number | string; delayMs?: number }
  | { rawBody: string; status?: number; delayMs?: number };

export type FakeAiCall = {
  path: string;
  /** First path segment, e.g. "groq" for /groq/v1/chat/completions. */
  route: string;
  model: string | null;
  stream: boolean;
  /** True when an `Authorization: Bearer …` header was sent. The key itself is not kept. */
  hasKey: boolean;
  body: Record<string, unknown>;
};

export type FakeAi = {
  url: string;
  calls: FakeAiCall[];
  /** Answer the next request on `route` with `reply` (first in, first out). */
  queue: (route: string, ...replies: FakeReply[]) => void;
  /** Answer every request on `route` with `reply` once its queue is empty. */
  setDefault: (route: string, reply: FakeReply) => void;
  /** Clear queues, defaults and calls. */
  reset: () => void;
  close: () => Promise<void>;
};

export async function startFakeAi(opts: { host?: string } = {}): Promise<FakeAi> {
  const host = opts.host ?? "127.0.0.1";
  const calls: FakeAiCall[] = [];
  const queues = new Map<string, FakeReply[]>();
  const defaults = new Map<string, FakeReply>();

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://fake.local").pathname;
    if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
      return send(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
    }
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: { message: "Body is not JSON", type: "invalid_request_error" } });
    }
    const route = path.split("/").filter(Boolean)[0] ?? "";
    const model = typeof body.model === "string" ? body.model : null;
    const stream = body.stream === true;
    const auth = req.headers.authorization ?? "";
    calls.push({ path, route, model, stream, hasKey: /^Bearer \S+/.test(auth), body });

    const reply = queues.get(route)?.shift() ?? defaults.get(route) ?? { text: "ok" };
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;

    if ("rawBody" in reply) {
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", connection: "close" });
      return res.end(reply.rawBody);
    }
    if ("status" in reply) {
      const headers: Record<string, string> = {};
      if (reply.retryAfter !== undefined) headers["retry-after"] = String(reply.retryAfter);
      const type = reply.status === 429 ? "rate_limit_exceeded" : "server_error";
      return send(res, reply.status, { error: { message: `Fake ${reply.status}`, type, code: type } }, headers);
    }
    if (stream) return sendStream(res, model ?? "fake", reply.text);
    return send(res, 200, {
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: 0,
      model: model ?? "fake",
      choices: [{ index: 0, message: { role: "assistant", content: reply.text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, { error: { message: String(err), type: "fake_error" } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${host}:${port}`,
    calls,
    queue: (route, ...replies) => {
      const q = queues.get(route) ?? [];
      q.push(...replies);
      queues.set(route, q);
    },
    setDefault: (route, reply) => void defaults.set(route, reply),
    reset: () => {
      queues.clear();
      defaults.clear();
      calls.length = 0;
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

function sendStream(res: ServerResponse, model: string, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  res.write(chunk({ role: "assistant", content: "" }, null));
  for (const piece of text.match(/\S+\s*|\s+/g) ?? []) res.write(chunk({ content: piece }, null));
  res.write(chunk({}, "stop"));
  res.end("data: [DONE]\n\n");
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", connection: "close", ...headers });
  res.end(JSON.stringify(body));
}

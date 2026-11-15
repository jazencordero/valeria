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
//
// From another process (M2-23). The whole-flow tests run the fake in Playwright's runner process
// (tests/e2e/global-setup.ts), the app's dev server calls it (AI_FAKE_URL, see router.ts), and the
// tests script it from their worker processes over a small HTTP control API:
//
//   const ai = connectFakeAi(process.env.AI_FAKE_URL!);
//   await ai.lock("my test");                      // wait for my turn, then start clean
//   await ai.queue("groq", { text: "Hello" });
//   (await ai.calls()).length;
//   await ai.unlock("my test");
//
//   GET  /__control/health                200 {ok:true}
//   POST /__control/queue    {route, replies: FakeReply[]}
//   POST /__control/default  {route, reply}
//   POST /__control/reset
//   GET  /__control/calls                 {calls: FakeAiCall[]}
//   POST /__control/lock     {owner, ttlMs?}   200 when `owner` now holds the lock, 423 while
//                                              someone else does. A lock ends after `ttlMs`
//                                              (default 120 s), so a killed test cannot keep it.
//   POST /__control/unlock   {owner}
//
// Why a lock: the dev server's provider routes are fixed, so two tests that script replies at
// the same time (the phone and the laptop project run side by side) would take each other's.
// A test that scripts the fake holds the lock for as long as it runs; tests that never queue
// anything do not need it and get the default answer.

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

/** The same fake, scripted from another process over HTTP. */
export type FakeAiClient = {
  url: string;
  queue: (route: string, ...replies: FakeReply[]) => Promise<void>;
  setDefault: (route: string, reply: FakeReply) => Promise<void>;
  reset: () => Promise<void>;
  calls: () => Promise<FakeAiCall[]>;
  /** Waits until `owner` holds the lock (up to `waitMs`, default 120 s), then resets the fake. */
  lock: (owner: string, opts?: { waitMs?: number; ttlMs?: number }) => Promise<void>;
  /** Resets the fake and gives the lock back. Does nothing when `owner` does not hold it. */
  unlock: (owner: string) => Promise<void>;
};

const CONTROL = "/__control/";
const DEFAULT_LOCK_MS = 120_000;

export async function startFakeAi(opts: { host?: string; port?: number } = {}): Promise<FakeAi> {
  const host = opts.host ?? "127.0.0.1";
  const calls: FakeAiCall[] = [];
  const queues = new Map<string, FakeReply[]>();
  const defaults = new Map<string, FakeReply>();
  let lock: { owner: string; until: number } | null = null;

  const queue = (route: string, ...replies: FakeReply[]) => {
    const q = queues.get(route) ?? [];
    q.push(...replies);
    queues.set(route, q);
  };
  const reset = () => {
    queues.clear();
    defaults.clear();
    calls.length = 0;
  };

  async function control(req: IncomingMessage, res: ServerResponse, action: string) {
    if (req.method === "GET" && action === "health") return send(res, 200, { ok: true });
    if (req.method === "GET" && action === "calls") return send(res, 200, { calls });
    if (req.method !== "POST") return send(res, 404, { error: "unknown control call" });
    let body: Record<string, unknown> = {};
    try {
      const raw = await readBody(req);
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "body is not JSON" });
    }
    const route = typeof body.route === "string" ? body.route : null;
    const owner = typeof body.owner === "string" && body.owner ? body.owner : null;
    switch (action) {
      case "queue":
        if (!route || !Array.isArray(body.replies)) return send(res, 400, { error: "needs route and replies" });
        queue(route, ...(body.replies as FakeReply[]));
        return send(res, 200, { ok: true });
      case "default":
        if (!route || !body.reply) return send(res, 400, { error: "needs route and reply" });
        defaults.set(route, body.reply as FakeReply);
        return send(res, 200, { ok: true });
      case "reset":
        reset();
        return send(res, 200, { ok: true });
      case "lock": {
        if (!owner) return send(res, 400, { error: "needs owner" });
        const now = Date.now();
        if (lock && lock.owner !== owner && lock.until > now) return send(res, 423, { ok: false });
        const ttl = typeof body.ttlMs === "number" && body.ttlMs > 0 ? body.ttlMs : DEFAULT_LOCK_MS;
        lock = { owner, until: now + ttl };
        return send(res, 200, { ok: true });
      }
      case "unlock":
        if (!owner) return send(res, 400, { error: "needs owner" });
        if (lock?.owner === owner) {
          lock = null;
          reset();
        }
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { error: "unknown control call" });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://fake.local").pathname;
    if (path.startsWith(CONTROL)) return control(req, res, path.slice(CONTROL.length));
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
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${host}:${port}`,
    calls,
    queue,
    setDefault: (route, reply) => void defaults.set(route, reply),
    reset,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** Scripts a fake that runs in another process. `url` is the fake's own address (`FakeAi.url`). */
export function connectFakeAi(url: string): FakeAiClient {
  const base = url.replace(/\/+$/, "") + CONTROL;
  async function call(action: string, body?: unknown): Promise<Response> {
    return fetch(base + action, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function post(action: string, body: unknown): Promise<void> {
    const res = await call(action, body);
    if (!res.ok) throw new Error(`fake AI: ${action} answered ${res.status}`);
  }
  return {
    url,
    queue: (route, ...replies) => post("queue", { route, replies }),
    setDefault: (route, reply) => post("default", { route, reply }),
    reset: () => post("reset", {}),
    calls: async () => ((await (await call("calls")).json()) as { calls: FakeAiCall[] }).calls,
    lock: async (owner, opts = {}) => {
      const deadline = Date.now() + (opts.waitMs ?? DEFAULT_LOCK_MS);
      for (;;) {
        const res = await call("lock", { owner, ttlMs: opts.ttlMs });
        if (res.ok) break;
        if (res.status !== 423) throw new Error(`fake AI: lock answered ${res.status}`);
        if (Date.now() > deadline) throw new Error("fake AI: another test held the lock for too long");
        await new Promise((r) => setTimeout(r, 150));
      }
      await post("reset", {});
    },
    unlock: (owner) => post("unlock", { owner }),
  };
}

/**
 * The SSE body of a reply that calls one tool, for `{ rawBody: toolCallBody(...) }`. The model
 * "decides" to call `name` with `args`; the next request on the route carries the tool's answer.
 */
export function toolCallBody(name: string, args: unknown): string {
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const call = { index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } };
  return chunk({ role: "assistant", content: null, tool_calls: [call] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
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

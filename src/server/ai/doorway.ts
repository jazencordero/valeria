/*
 * The one doorway for AI calls from screens. Every route under `src/app/api/ai/<job>/route.ts`
 * is built with it (`tests/arch/ai-boundary.test.ts` checks):
 *
 *   export const POST = aiRoute(
 *     async ({ body, ai }) => {
 *       const { text } = await ai.runText({ messages: [{ role: "user", content: body.question }], job: "explain-card" });
 *       return { text };                       // a plain value is sent as JSON; a Response is sent as is
 *     },
 *     { size: "small", perUserPerHour: 30, body: z.object({ question: z.string().max(2000) }) },
 *   );
 *
 * In order, before the handler runs:
 * - No signed-in user (no valid `ready_session` cookie with a session row): 401 `{error:'not_signed_in'}`.
 * - The user already has `perUserPerHour` rows in `ai_calls` in the last hour: 429 `{error:'slow_down'}`.
 *   Every row counts (one per HTTP attempt, ok or not), so a fallback across providers costs more.
 * - The body is not JSON, or does not match the handler's zod schema: 400 `{error:'bad_request'}`,
 *   with the paths and messages of the issues (never the values she sent). An empty body is `{}`.
 * Then, from the handler: `AiBusy` becomes 503 `{error:'ai_busy', message:'AI is busy. Try again in a
 * few minutes.'}`. Anything else is rethrown, so Next answers 500.
 *
 * The handler gets `ai`: the router's `runText`, `runObject` and `streamChat`, with this route's
 * size and the signed-in user filled in. Screens never import `router.ts` or the AI SDK directly.
 * No streaming helpers here: the chat route (M2-14) returns `result.toUIMessageStreamResponse()`. Prompts and bodies are never logged.
 *
 * `createAiRoute(deps)` takes the router, database, clock and user lookup, so tests can run it
 * against `createTestDb()` and `tests/fake-ai/server.ts`.
 */
import { and, count, eq, gt } from "drizzle-orm";
import type { z } from "zod";
import { NotSignedIn, SESSION_COOKIE, currentUserFor, type User } from "@/server/auth/session";
import { db as defaultDb, type Db } from "@/server/db/client";
import { aiCalls } from "@/server/db/schema/system";
import type { SizeClass } from "./providers.config";
import * as defaultRouter from "./router";
import {
  AiBusy,
  type RunInput,
  type RunObjectResult,
  type RunTextResult,
  type StreamChatInput,
  type StreamChatResult,
} from "./router";

export const AI_BUSY_MESSAGE = "AI is busy. Try again in a few minutes.";
const HOUR_MS = 60 * 60 * 1000;

type Router = {
  runText: (input: RunInput) => Promise<RunTextResult>;
  runObject: <T>(input: RunInput & { schema: z.ZodType<T> }) => Promise<RunObjectResult<T>>;
  streamChat: (input: StreamChatInput) => Promise<StreamChatResult>;
};

export type DoorwayDeps = {
  router?: Router;
  database?: Db;
  now?: () => Date;
  /** The signed-in user for this request; throw `NotSignedIn` when there is none. */
  userFor?: (request: Request, database: Db) => Promise<User>;
};

/** What a handler passes to `ai.*`: the router input without size and user (the doorway fills them). */
export type AiInput = Omit<RunInput, "size" | "userId"> & { size?: SizeClass };
/** The same for `ai.streamChat`, which also takes tools, `maxToolRounds` and `onEnd`. */
export type AiStreamInput = Omit<StreamChatInput, "size" | "userId"> & { size?: SizeClass };

export type DoorwayAi = {
  runText: (input: AiInput) => Promise<RunTextResult>;
  runObject: <T>(input: AiInput & { schema: z.ZodType<T> }) => Promise<RunObjectResult<T>>;
  streamChat: (input: AiStreamInput) => Promise<StreamChatResult>;
};

export type AiRouteOptions<S extends z.ZodType> = {
  size: SizeClass;
  perUserPerHour: number;
  /** The zod schema the JSON body must match. */
  body: S;
};

export type AiHandlerContext<T> = {
  request: Request;
  user: User;
  body: T;
  ai: DoorwayAi;
  params: Promise<Record<string, string | string[] | undefined>>;
};

export type AiHandler<T> = (ctx: AiHandlerContext<T>) => Promise<unknown> | unknown;

export type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

/** The session token from the request's `cookie` header, if any. */
export function sessionTokenFrom(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(at + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

const defaultUserFor = (request: Request, database: Db) => currentUserFor(database, sessionTokenFrom(request));

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function readBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false };
  }
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function createAiRoute(deps: DoorwayDeps = {}) {
  const router = (): Router => deps.router ?? defaultRouter;
  const database = () => deps.database ?? defaultDb;
  const now = deps.now ?? (() => new Date());
  const userFor = deps.userFor ?? defaultUserFor;

  async function callsInLastHour(userId: string): Promise<number> {
    const since = new Date(now().getTime() - HOUR_MS);
    const [row] = await database()
      .select({ n: count() })
      .from(aiCalls)
      .where(and(eq(aiCalls.userId, userId), gt(aiCalls.createdAt, since)));
    return row?.n ?? 0;
  }

  return function aiRoute<S extends z.ZodType>(handler: AiHandler<z.output<S>>, options: AiRouteOptions<S>) {
    return async function route(request: Request, context?: RouteContext): Promise<Response> {
      let user: User;
      try {
        user = await userFor(request, database());
      } catch (error) {
        if (error instanceof NotSignedIn) return json(401, { error: "not_signed_in" });
        throw error;
      }

      if ((await callsInLastHour(user.id)) >= options.perUserPerHour) {
        return json(429, { error: "slow_down" });
      }

      const raw = await readBody(request);
      if (!raw.ok) return json(400, { error: "bad_request", issues: [{ path: "", message: "The body is not JSON." }] });
      const parsed = options.body.safeParse(raw.value);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
        return json(400, { error: "bad_request", issues });
      }

      const fill = <I extends AiInput | AiStreamInput>(input: I) => ({ ...input, size: input.size ?? options.size, userId: user.id });
      const ai: DoorwayAi = {
        runText: (input) => router().runText(fill(input)),
        runObject: (input) => router().runObject(fill(input)),
        streamChat: (input) => router().streamChat(fill(input)),
      };

      try {
        const out = await handler({
          request,
          user,
          body: parsed.data as z.output<S>,
          ai,
          params: context?.params ?? Promise.resolve({}),
        });
        return out instanceof Response ? out : json(200, out ?? null);
      } catch (error) {
        if (error instanceof AiBusy) return json(503, { error: "ai_busy", message: AI_BUSY_MESSAGE });
        throw error;
      }
    };
  };
}

/** Wraps a route handler under `src/app/api/ai/`. See the header for what it checks and returns. */
export const aiRoute = createAiRoute();

/*
 * Same input, same answer, one call.
 *
 *   const card = await cached("explain-card", { cardId, pages }, () => callModel(...), { model });
 *
 * The key is SHA-256 of `job` plus a stable JSON of `input` (object keys
 * sorted at every depth, so key order never changes the hash). A stored
 * `ai_cache.output` is returned as is; otherwise `produce()` runs once, its
 * result is stored and returned. Concurrent calls with the same key in this
 * process share one `produce()`. A failed `produce()` stores nothing.
 *
 * No expiry: cards and explanations are meant to be made once.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { aiCache } from "@/server/db/schema/system";

export type CachedOptions = {
  /** Stored in `ai_cache.model` for reference; not part of the key. */
  model?: string;
  database?: Db;
};

/** Plain-JSON copy of `value` with object keys sorted, as `JSON.stringify` would see it. */
function normalize(value: unknown): unknown {
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : normalize(item)));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      out[key] = normalize(item);
    }
    return out;
  }
  return value;
}

/** JSON with object keys sorted at every depth. */
export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? "null";
}

/** The `ai_cache.hash` for a job and its input: 64 hex characters. */
export function cacheKey(job: string, input: unknown): string {
  return createHash("sha256").update(stableJson([job, input])).digest("hex");
}

const inFlight = new Map<string, Promise<unknown>>();

export async function cached<T>(
  job: string,
  input: unknown,
  produce: () => Promise<T> | T,
  { model = "unknown", database = defaultDb }: CachedOptions = {},
): Promise<T> {
  const hash = cacheKey(job, input);

  const running = inFlight.get(hash);
  if (running) return running as Promise<T>;

  const work = (async () => {
    const [hit] = await database
      .select({ output: aiCache.output })
      .from(aiCache)
      .where(eq(aiCache.hash, hash))
      .limit(1);
    if (hit) return hit.output as T;

    const output = await produce();
    // Another server instance may have stored the same hash meanwhile; keep the first.
    await database
      .insert(aiCache)
      .values({ hash, job, model, output: output as unknown })
      .onConflictDoNothing({ target: aiCache.hash });
    return output;
  })();

  inFlight.set(hash, work);
  try {
    return await work;
  } finally {
    inFlight.delete(hash);
  }
}

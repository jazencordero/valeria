// Moodle web service client for the app. Plain fetch only, so it runs in any
// server runtime. The token travels in the POST body, never in a URL we build
// for a call, and never in a log line or an error message.
//
// With MOODLE_FAKE=1 every call and form post is answered in-process by
// ./fake-inline (never in production). Those answers skip the politeness
// rules below: they never reach a Moodle server.
//
// Politeness (per user: `conn.userId`, else one shared bucket per site and key):
// - at most 2 requests in flight and at least 150 ms between request starts;
// - HTTP 429 or 503 is retried up to 3 times, after `Retry-After` seconds or
//   else 2, 4 and 8 seconds, then it is MoodleDown;
// - at most 2,000 requests per Helsinki day, then MoodleDown("daily limit")
//   without a request. Counted in memory, with users.settings.moodleCalls as
//   the fallback for a fresh server instance (see `dbCallCountStore`).
// Every request, form posts included, says `User-Agent: Ready/0.1 (student study tool)`.
// The limits are guesses until Aalto IT answers (M0-11).

export type MoodleConn = {
  siteUrl: string;
  token: string;
  /** Our users.id. Limits and the daily count are kept per user; without it, per site and key. */
  userId?: string;
};

/** Moodle params: nested objects and arrays, flattened by `flattenParams`. */
export type MoodleParams = { [key: string]: MoodleParam };
export type MoodleParam = string | number | boolean | null | undefined | MoodleParam[] | { [key: string]: MoodleParam };

export type CallOptions = {
  /** Defaults to 15 seconds. Tests pass a short one. */
  timeoutMs?: number;
};

export const MOODLE_TIMEOUT_MS = 15_000;

export const USER_AGENT = "Ready/0.1 (student study tool)";
export const MAX_IN_FLIGHT = 2;
export const MIN_GAP_MS = 150;
export const MAX_RETRIES = 3;
/** Waits when Moodle sends no usable Retry-After: 2, 4, 8 seconds. */
export const BACKOFF_MS = [2_000, 4_000, 8_000];
/** A Retry-After longer than this is not waited for; the call is MoodleDown at once. */
export const MAX_RETRY_AFTER_MS = 60_000;
export const DAILY_LIMIT = 2_000;
/** The day the daily limit counts in: the students' local day. */
export const DAY_TIME_ZONE = "Europe/Helsinki";

type ErrorInit = { errorcode?: string | null; exception?: string | null; status?: number | null };

/** Any error answered by Moodle that has no more specific class below. */
export class MoodleError extends Error {
  readonly errorcode: string | null;
  readonly exception: string | null;
  readonly status: number | null;
  constructor(message: string, init: ErrorInit = {}) {
    super(message);
    this.name = "MoodleError";
    this.errorcode = init.errorcode ?? null;
    this.exception = init.exception ?? null;
    this.status = init.status ?? null;
  }
}

/** The key is wrong, expired, or no longer allowed to use the service. */
export class KeyRejected extends MoodleError {
  constructor(message: string, init: ErrorInit = {}) {
    super(message, init);
    this.name = "KeyRejected";
  }
}

/** The key works, but this function does not exist or is not in its service. */
export class NotAllowed extends MoodleError {
  readonly fn: string;
  constructor(fn: string, init: ErrorInit = {}) {
    super(`Moodle does not allow ${fn}`, init);
    this.name = "NotAllowed";
    this.fn = fn;
  }
}

/** Moodle could not be reached, timed out, or answered with a 5xx. */
export class MoodleDown extends MoodleError {
  constructor(message: string, init: ErrorInit = {}) {
    super(message, init);
    this.name = "MoodleDown";
  }
}

/**
 * Flatten params the way Moodle's REST server reads them:
 * `{ courseids: [3], options: [{ name: "x", value: true }] }` becomes
 * `courseids[0]=3`, `options[0][name]=x`, `options[0][value]=1`.
 * Keeps order; skips null and undefined; booleans become 1 and 0.
 */
export function flattenParams(params: MoodleParam, prefix = ""): [string, string][] {
  if (params === null || params === undefined) return [];
  if (typeof params !== "object") return [[prefix, scalar(params)]];
  const entries: [string, MoodleParam][] = Array.isArray(params)
    ? params.map((v, i) => [String(i), v])
    : Object.entries(params);
  const out: [string, string][] = [];
  for (const [k, v] of entries) {
    if (v === null || v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") out.push(...flattenParams(v, key));
    else out.push([key, scalar(v)]);
  }
  return out;
}

function scalar(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "1" : "0";
  return String(v);
}

function base(siteUrl: string): string {
  return siteUrl.replace(/\/+$/, "");
}

function fakeOn(): boolean {
  return process.env.MOODLE_FAKE === "1";
}

/** Call one web service function and return Moodle's JSON answer. */
export async function callMoodle<T = unknown>(
  conn: MoodleConn,
  fn: string,
  params: MoodleParams = {},
  options: CallOptions = {},
): Promise<T> {
  if (fakeOn()) {
    const fake = await import("./fake-inline");
    return fake.fakeCall(conn, fn, params) as T;
  }
  const body = new URLSearchParams();
  body.append("wstoken", conn.token);
  body.append("wsfunction", fn);
  body.append("moodlewsrestformat", "json");
  for (const [k, v] of flattenParams(params)) body.append(k, v);
  return (await politely(conn, `${base(conn.siteUrl)}/webservice/rest/server.php`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body,
  }, options, (res) => readAnswer(res, fn))) as T;
}

/**
 * POST a multipart form to a Moodle endpoint other than the REST server (a
 * file endpoint, say), under the same politeness rules and User-Agent, and
 * return Moodle's JSON answer. `path` is relative to the site, for example
 * "/webservice/x.php". The caller puts the token in `form` under the field
 * name that endpoint reads. Moodle error answers throw like `callMoodle`.
 */
export async function postMoodleForm(
  conn: MoodleConn,
  path: string,
  form: FormData,
  options: CallOptions = {},
): Promise<unknown> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("postMoodleForm needs a path on her site");
  if (fakeOn()) {
    const fake = await import("./fake-inline");
    return fake.fakeForm(conn, path, form);
  }
  return politely(conn, `${base(conn.siteUrl)}${path}`, {
    method: "POST",
    headers: { "user-agent": USER_AGENT },
    body: form,
  }, options, (res) => readAnswer(res, path));
}

/**
 * A download link for a file Moodle gave us (for example an intro attachment's
 * `fileurl`), with the token added. Only for files on her own Moodle site: a
 * URL on any other host comes back unchanged, so the token never leaves it.
 * Treat the result as secret: do not log it or send it to the browser.
 */
export function fileUrl(conn: MoodleConn, url: string): string {
  const site = new URL(base(conn.siteUrl) + "/");
  const u = new URL(url, site);
  if (u.origin !== site.origin) return url;
  // Token downloads only work through the web service file server.
  if (!u.pathname.includes("/webservice/pluginfile.php") && u.pathname.includes("/pluginfile.php")) {
    u.pathname = u.pathname.replace("/pluginfile.php", "/webservice/pluginfile.php");
  }
  u.searchParams.set("token", conn.token);
  return u.toString();
}

// ---------------------------------------------------------------------------
// Politeness: throttle, retries, daily count.

/** Where the daily count survives a fresh server instance. Days are `YYYY-MM-DD`. */
export type CallCountStore = {
  /** The count saved for this user and day, or 0. */
  load: (userId: string, day: string) => Promise<number>;
  /** Save the count; never lowers a count already saved for the same day. */
  save: (userId: string, day: string, count: number) => Promise<void>;
};

export type ClientConfig = {
  /** Fallback for the daily count of calls made with a userId. Defaults to `dbCallCountStore()`; null for memory only. */
  countStore: CallCountStore | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const defaults = (): ClientConfig => ({
  countStore: dbCallCountStore(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

let config: ClientConfig = defaults();

/** Swap the clock, the sleep or the count store (tests). */
export function configureMoodleClient(change: Partial<ClientConfig>): void {
  config = { ...config, ...change };
}

/** Back to the defaults, and forget every throttle and daily count in memory (tests). */
export function resetMoodleClient(): void {
  config = defaults();
  limiters.clear();
  counts.clear();
}

/**
 * The daily count in users.settings.moodleCalls = { day, count }. The database
 * client is imported only when it is first used, so importing this module
 * never opens a database. Pass `db` to use another handle (tests).
 */
export function dbCallCountStore(db?: import("../db/client").Db): CallCountStore {
  const handle = async () => {
    const [{ sql, eq }, { users }] = await Promise.all([import("drizzle-orm"), import("../db/schema/users")]);
    return { d: db ?? (await import("../db/client")).db, sql, eq, users };
  };
  return {
    async load(userId, day) {
      const { d, eq, users } = await handle();
      const [row] = await d.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).limit(1);
      const saved = row?.settings?.moodleCalls as { day?: unknown; count?: unknown } | undefined;
      const count = Number(saved?.count);
      return saved?.day === day && Number.isFinite(count) ? count : 0;
    },
    async save(userId, day, count) {
      const { d, sql, eq, users } = await handle();
      const was = sql`${users.settings}->'moodleCalls'`;
      await d
        .update(users)
        .set({
          settings: sql`jsonb_set(${users.settings}, '{moodleCalls}', jsonb_build_object(
            'day', ${day}::text,
            'count', case when ${was}->>'day' = ${day}::text
              then greatest(coalesce((${was}->>'count')::int, 0), ${count}::int)
              else ${count}::int end))`,
        })
        .where(eq(users.id, userId));
    },
  };
}

/** `YYYY-MM-DD` of this moment in Helsinki. */
export function moodleDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: DAY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** Who a call counts against: her user id, or the site and a hash of the key (never the key itself). */
function bucket(conn: MoodleConn): string {
  if (conn.userId) return `user:${conn.userId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < conn.token.length; i++) h = Math.imul(h ^ conn.token.charCodeAt(i), 0x01000193) >>> 0;
  return `anon:${base(conn.siteUrl)}:${h.toString(16)}`;
}

/** At most MAX_IN_FLIGHT holders at once, and starts at least MIN_GAP_MS apart. */
class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];
  private nextStart = 0;

  async acquire(): Promise<void> {
    if (this.active < MAX_IN_FLIGHT) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve)); // the slot is handed over
    const now = config.now();
    const at = Math.max(now, this.nextStart);
    this.nextStart = at + MIN_GAP_MS;
    if (at > now) await config.sleep(at - now);
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}

const limiters = new Map<string, Limiter>();
type DayCount = { day: string; count: number };
const counts = new Map<string, DayCount | Promise<DayCount>>();

function limiterFor(key: string): Limiter {
  let l = limiters.get(key);
  if (!l) limiters.set(key, (l = new Limiter()));
  return l;
}

/** Count one request against today's limit, or refuse it before it is made. */
async function countRequest(key: string, userId: string | undefined): Promise<void> {
  const day = moodleDay(config.now());
  const store = userId ? config.countStore : null;
  let entry: DayCount | undefined;
  while (!entry) {
    const known = counts.get(key);
    if (known instanceof Promise) {
      // Someone else is loading; take their answer, then read the map again.
      const loaded = await known;
      if (counts.get(key) === known) counts.set(key, loaded);
    } else if (known && known.day === day) {
      entry = known;
    } else {
      // Set synchronously, so calls that arrive while it loads share this one load.
      const loading = (async (): Promise<DayCount> => ({
        day,
        count: store && userId ? await store.load(userId, day).catch(() => 0) : 0,
      }))();
      counts.set(key, loading);
      entry = await loading;
      if (counts.get(key) === loading) counts.set(key, entry);
    }
  }
  if (entry.count >= DAILY_LIMIT) throw new MoodleDown("daily limit", { errorcode: "dailylimit" });
  entry.count++;
  // A database hiccup must not stop the call; memory still counts it.
  if (store && userId) await store.save(userId, day, entry.count).catch(() => {});
}

/** Seconds or an HTTP date, as milliseconds to wait; null when missing or unreadable. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const v = header.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - config.now());
}

/** Send under the user's throttle and daily limit, retrying 429 and 503; `read` turns the answer into a result. */
async function politely<T>(
  conn: MoodleConn,
  url: string,
  init: RequestInit,
  options: CallOptions,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  const key = bucket(conn);
  const limiter = limiterFor(key);
  for (let attempt = 0; ; attempt++) {
    await countRequest(key, conn.userId);
    await limiter.acquire();
    let wait: number;
    try {
      const res = await send(url, init, options);
      if (res.status !== 429 && res.status !== 503) return await read(res);
      await res.body?.cancel().catch(() => {});
      const why = { errorcode: `http_${res.status}`, status: res.status };
      if (attempt >= MAX_RETRIES) {
        throw new MoodleDown(`Moodle answered HTTP ${res.status} ${attempt + 1} times`, why);
      }
      wait = retryAfterMs(res.headers.get("retry-after")) ?? BACKOFF_MS[attempt];
      if (wait > MAX_RETRY_AFTER_MS) {
        throw new MoodleDown(`Moodle asked us to wait ${Math.round(wait / 1000)} s`, why);
      }
    } finally {
      limiter.release();
    }
    await config.sleep(wait);
  }
}

async function send(url: string, init: RequestInit, options: CallOptions): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? MOODLE_TIMEOUT_MS;
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new MoodleDown(`Moodle did not answer within ${Math.round(timeoutMs / 1000)} s`, { errorcode: "timeout" });
    }
    throw new MoodleDown("Could not reach Moodle", { errorcode: "network" });
  }
}

type MoodleErrorBody = { exception?: string; errorcode?: string; message?: string; error?: string; debuginfo?: string };

async function readAnswer(res: Response, fn: string): Promise<unknown> {
  if (res.status >= 500) {
    throw new MoodleDown(`Moodle answered HTTP ${res.status}`, { errorcode: `http_${res.status}`, status: res.status });
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new MoodleError(`Moodle answered HTTP ${res.status} with something that is not JSON`, {
      errorcode: "invalidresponse",
      status: res.status,
    });
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const e = body as MoodleErrorBody;
    if (e.exception || e.errorcode) throw toError(e, fn, res.status);
  }
  if (!res.ok) {
    throw new MoodleError(`Moodle answered HTTP ${res.status}`, { errorcode: `http_${res.status}`, status: res.status });
  }
  return body;
}

// How Moodle reports each case (webservice/lib.php):
// - bad token: moodle_exception "invalidtoken".
// - expired token, IP or user restrictions, disabled service: webservice_access_exception,
//   errorcode "accessexception".
// - function not in the token's service: also "accessexception", told apart only by the
//   debuginfo "Access to the function x() is not allowed", which Moodle sends only when
//   debugging is on. Without it we cannot tell, and treat it as a rejected key.
// - function that does not exist: dml_missing_record_exception "invalidrecord" on the
//   table external_functions.
function toError(e: MoodleErrorBody, fn: string, status: number): MoodleError {
  const init = { errorcode: e.errorcode ?? null, exception: e.exception ?? null, status };
  const message = e.message || e.error || e.errorcode || "Moodle error";
  const debug = e.debuginfo ?? "";
  if (e.errorcode === "invalidrecord" && /external_functions/.test(`${message} ${debug}`)) return new NotAllowed(fn, init);
  if (e.errorcode === "accessexception" && /Access to the function/i.test(debug)) return new NotAllowed(fn, init);
  if (e.errorcode === "invalidtoken" || e.errorcode === "accessexception") return new KeyRejected(message, init);
  return new MoodleError(message, init);
}

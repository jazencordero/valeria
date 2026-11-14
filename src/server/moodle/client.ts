// Moodle web service client for the app. Plain fetch only, so it runs in any
// server runtime. The token travels in the POST body, never in a URL we build
// for a call, and never in a log line or an error message.
//
// With MOODLE_FAKE=1 every call and upload is answered in-process by
// ./fake-inline (never in production).

export type MoodleConn = { siteUrl: string; token: string };

/** Moodle params: nested objects and arrays, flattened by `flattenParams`. */
export type MoodleParams = { [key: string]: MoodleParam };
export type MoodleParam = string | number | boolean | null | undefined | MoodleParam[] | { [key: string]: MoodleParam };

export type CallOptions = {
  /** Defaults to 15 seconds. Tests pass a short one. */
  timeoutMs?: number;
};

export const MOODLE_TIMEOUT_MS = 15_000;

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
  const res = await send(`${base(conn.siteUrl)}/webservice/rest/server.php`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }, options);
  return (await readAnswer(res, fn)) as T;
}

/** Upload one file to her draft area. Returns the draft `itemid` to pass to save_submission. */
export async function uploadFile(
  conn: MoodleConn,
  bytes: Uint8Array | ArrayBuffer | Blob,
  filename: string,
  options: CallOptions = {},
): Promise<number> {
  if (fakeOn()) {
    const fake = await import("./fake-inline");
    return fake.fakeUpload(conn, filename);
  }
  const form = new FormData();
  form.append("token", conn.token);
  form.append("filearea", "draft");
  form.append("itemid", "0");
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart]);
  form.append("file_1", blob, filename);
  const res = await send(`${base(conn.siteUrl)}/webservice/upload.php`, { method: "POST", body: form }, options);
  const answer = await readAnswer(res, "upload");
  const first = Array.isArray(answer) ? (answer[0] as { itemid?: unknown } | undefined) : undefined;
  const itemid = Number(first?.itemid);
  if (!first || !Number.isFinite(itemid)) {
    throw new MoodleError("Upload answer had no itemid", { errorcode: "invalidresponse", status: res.status });
  }
  return itemid;
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

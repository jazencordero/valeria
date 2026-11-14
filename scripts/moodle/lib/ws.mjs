// Moodle web service client for the Milestone 0 test sitting.
// Node 20+, no dependencies. Never logs or puts the token in error messages.

/** Error returned by Moodle (an answer with `exception` or `errorcode`) or by HTTP. */
export class MoodleError extends Error {
  constructor({ message, errorcode, exception, debuginfo, status } = {}) {
    super(message || errorcode || "Moodle error");
    this.name = "MoodleError";
    this.errorcode = errorcode ?? null;
    this.exception = exception ?? null;
    this.debuginfo = debuginfo ?? null;
    this.status = status ?? null;
  }
}

/**
 * Flatten nested params the way Moodle's REST server expects:
 * { courseids: [3, 4], options: [{ name: "x", value: true }] }
 *   -> courseids[0]=3, courseids[1]=4, options[0][name]=x, options[0][value]=1
 * Returns an array of [key, value] string pairs (keeps order, allows repeats).
 */
export function flattenParams(params, prefix = "") {
  const out = [];
  if (params === null || params === undefined) return out;
  if (typeof params !== "object") {
    out.push([prefix, scalar(params)]);
    return out;
  }
  const entries = Array.isArray(params)
    ? params.map((v, i) => [String(i), v])
    : Object.entries(params);
  for (const [k, v] of entries) {
    if (v === null || v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") out.push(...flattenParams(v, key));
    else out.push([key, scalar(v)]);
  }
  return out;
}

function scalar(v) {
  if (typeof v === "boolean") return v ? "1" : "0";
  return String(v);
}

function base(site) {
  return String(site).replace(/\/+$/, "");
}

async function readJson(res) {
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new MoodleError({
      message: `Moodle answered HTTP ${res.status} with non-JSON`,
      errorcode: "invalidresponse",
      status: res.status,
    });
  }
  if (body && typeof body === "object" && !Array.isArray(body) && (body.exception || body.errorcode)) {
    throw new MoodleError({
      message: body.message || body.error,
      errorcode: body.errorcode,
      exception: body.exception,
      debuginfo: body.debuginfo,
      status: res.status,
    });
  }
  if (!res.ok) {
    throw new MoodleError({ message: `Moodle answered HTTP ${res.status}`, errorcode: `http_${res.status}`, status: res.status });
  }
  return body;
}

/** Call a web service function. The token goes in the POST body, never the URL. */
export async function call(site, token, fn, params = {}) {
  const body = new URLSearchParams();
  body.append("wstoken", token);
  body.append("wsfunction", fn);
  body.append("moodlewsrestformat", "json");
  for (const [k, v] of flattenParams(params)) body.append(k, v);
  const res = await fetch(`${base(site)}/webservice/rest/server.php`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return readJson(res);
}

/** Upload bytes to the user's draft area. Returns the draft `itemid`. */
export async function upload(site, token, bytes, filename) {
  const form = new FormData();
  form.append("token", token);
  form.append("filearea", "draft");
  form.append("itemid", "0");
  form.append("file_1", new Blob([bytes]), filename);
  const res = await fetch(`${base(site)}/webservice/upload.php`, { method: "POST", body: form });
  const body = await readJson(res);
  const first = Array.isArray(body) ? body[0] : null;
  if (!first || first.itemid === undefined) {
    throw new MoodleError({ message: "Upload answer had no itemid", errorcode: "invalidresponse", status: res.status });
  }
  return first.itemid;
}

// Fake Moodle HTTP server for tests. All data is invented.
//
//   const moodle = await startFakeMoodle();
//   await callMoodle({ siteUrl: moodle.url, token: moodle.token }, "core_webservice_get_site_info");
//   moodle.calls  // every request it received
//   await moodle.close();
//
// It answers /webservice/rest/server.php by `wsfunction` from `<dir>/<wsfunction>.json`
// (default tests/fixtures/moodle-sample/), and /webservice/upload.php with a draft itemid.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_TOKEN = "fake-moodle-test-token";
export const FAKE_UPLOAD_ITEMID = 777001;
const DEFAULT_DIR = fileURLToPath(new URL("../fixtures/moodle-sample/", import.meta.url));

export type FakeCall = {
  path: string;
  /** The wsfunction, or "upload" for /webservice/upload.php. */
  fn: string;
  /** The form fields as received (flattened keys), without wstoken, wsfunction and the format. */
  params: Record<string, string>;
  token: string | null;
};

/** A canned answer for one function, used instead of its JSON file. */
export type Override = { status?: number; body?: unknown; delayMs?: number };

export type FakeMoodle = {
  url: string;
  token: string;
  calls: FakeCall[];
  /** Answer every later request made with this token as Moodle does for a bad key. */
  rejectToken: (token?: string) => void;
  /** Answer `fn` (or "upload") with this instead of the JSON file. */
  override: (fn: string, answer: Override) => void;
  close: () => Promise<void>;
};

const INVALID_TOKEN = { exception: "moodle_exception", errorcode: "invalidtoken", message: "Invalid token - token not found" };
const NO_FUNCTION = {
  exception: "dml_missing_record_exception",
  errorcode: "invalidrecord",
  message: "Can't find data record in database table external_functions.",
};

export async function startFakeMoodle(opts: { dir?: string; token?: string; host?: string } = {}): Promise<FakeMoodle> {
  const dir = opts.dir ?? DEFAULT_DIR;
  const token = opts.token ?? FAKE_TOKEN;
  const host = opts.host ?? "127.0.0.1";
  const calls: FakeCall[] = [];
  const rejected = new Set<string>();
  const overrides = new Map<string, Override>();

  async function answer(res: ServerResponse, fn: string, given: string | null, fromFile: () => Promise<unknown>) {
    if (given !== token || rejected.has(given)) return json(res, 200, INVALID_TOKEN);
    const o = overrides.get(fn);
    if (o) {
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (res.destroyed) return;
      return json(res, o.status ?? 200, o.body ?? null);
    }
    return json(res, 200, await fromFile());
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://fake.local").pathname;
    const raw = await readBody(req);

    if (req.method === "POST" && path === "/webservice/rest/server.php") {
      const form = new URLSearchParams(raw.toString("utf8"));
      const fn = form.get("wsfunction") ?? "";
      const params: Record<string, string> = {};
      for (const [k, v] of form) {
        if (k !== "wstoken" && k !== "wsfunction" && k !== "moodlewsrestformat") params[k] = v;
      }
      calls.push({ path, fn, params, token: form.get("wstoken") });
      if (form.get("moodlewsrestformat") !== "json") {
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end("<?xml version=\"1.0\"?><RESPONSE/>");
      }
      return answer(res, fn, form.get("wstoken"), async () => {
        if (!/^[a-z0-9_]+$/.test(fn)) return NO_FUNCTION;
        try {
          return JSON.parse(await readFile(join(dir, `${fn}.json`), "utf8"));
        } catch {
          return NO_FUNCTION;
        }
      });
    }

    if (req.method === "POST" && path === "/webservice/upload.php") {
      const form = await new Response(new Uint8Array(raw), {
        headers: { "content-type": req.headers["content-type"] ?? "" },
      }).formData();
      const file = form.get("file_1");
      const given = typeof form.get("token") === "string" ? (form.get("token") as string) : null;
      const params: Record<string, string> = {};
      for (const [k, v] of form) {
        if (k === "token") continue;
        params[k] = typeof v === "string" ? v : v.name;
      }
      calls.push({ path, fn: "upload", params, token: given });
      return answer(res, "upload", given, async () => {
        if (!file || typeof file === "string") return { error: "No file was uploaded", errorcode: "nofile" };
        return [
          {
            component: "user",
            contextid: 5,
            userid: "4242",
            filearea: "draft",
            filename: file.name,
            filepath: "/",
            itemid: FAKE_UPLOAD_ITEMID,
            license: "allrightsreserved",
            author: "Test Student",
            source: "",
          },
        ];
      });
    }

    json(res, 404, { error: "Not found", errorcode: "notfound" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) json(res, 500, { error: String(err), errorcode: "fakeerror" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${host}:${port}`,
    token,
    calls,
    rejectToken: (t = token) => void rejected.add(t),
    override: (fn, a) => void overrides.set(fn, a),
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

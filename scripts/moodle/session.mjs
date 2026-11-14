// Sign in once for tonight's tests (ticket M0-15).
//
// A TEST CONVENIENCE for her own Mac session, with her consent, for the M0 sittings only.
// It is NOT the app's design: the app never stores her key on a device like this.
//
// It reads the MyCourses "View QR code" QR (from a clipboard screenshot, or a saved image),
// swaps it for a key, and keeps the key in her Mac's login Keychain (service
// "ready-moodle-test", account = the site) so probe.mjs and fetch-lectures.mjs can run
// without pasting anything. `logout` removes it. The key and the QR text are never printed,
// logged or written to a file; the clipboard image goes to a 0600 temp file that is deleted.
//
// Usage:
//   node scripts/moodle/session.mjs login  [--site <url>] [--file <image>] [--mock]
//   node scripts/moodle/session.mjs status [--site <url>] [--mock]
//   node scripts/moodle/session.mjs logout [--site <url>] [--mock]
// Default site: https://mycourses.aalto.fi (same as probe.mjs and fetch-lectures.mjs).
// --mock runs against scripts/moodle/mock.mjs (starts one, or --site for a running one).

import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import jsQR from "jsqr";
import { call, MoodleError } from "./lib/ws.mjs";
import { exchangeQr, parseQr } from "./lib/keys.mjs";
import * as keychain from "./lib/keychain.mjs";

export const DEFAULT_SITE = "https://mycourses.aalto.fi";
export const LOGIN_PROMPT =
  "Show the QR code on your MyCourses profile, take a screenshot of just the code to the clipboard (Cmd+Ctrl+Shift+4), then press Enter";

// ---- Secrets: everything printed goes through scrub() ---------------------------------

const secrets = new Set();
function remember(s) {
  if (s && String(s).length >= 4) secrets.add(String(s));
}
export function scrub(text) {
  let out = String(text ?? "");
  for (const s of secrets) out = out.split(s).join("REDACTED");
  return out.replace(/((?:ws)?token|qrlogin)=[^&\s'"]+/gi, "$1=REDACTED");
}
const say = (s) => process.stdout.write(scrub(s) + "\n");
const warn = (s) => process.stderr.write(scrub(s) + "\n");

// ---- Input ----------------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { cmd: null, site: null, file: null, mock: false, help: false };
  const need = (i, name) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--site") o.site = need(++i, a);
    else if (a === "--file") o.file = need(++i, a);
    else if (a === "--mock") o.mock = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!a.startsWith("-") && !o.cmd) o.cmd = a;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!o.help && !["login", "logout", "status"].includes(o.cmd)) throw new Error("Say login, status or logout");
  if (o.file && o.cmd !== "login") throw new Error("--file goes with login");
  return o;
}

// Piped stdin (tests, scripts) is read once and handed out line by line.
let pipedLines = null;
async function nextPipedLine() {
  if (pipedLines === null) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    pipedLines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  }
  return (pipedLines.shift() ?? "").trim();
}

function askLine(question) {
  process.stderr.write(question);
  if (!process.stdin.isTTY) return nextPipedLine();
  return new Promise((done) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        done(buf.slice(0, nl).replace(/\r$/, "").trim());
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

/** Read a line without echoing it (same approach as probe.mjs). Piped: the next line. */
function askHidden(question) {
  if (!process.stdin.isTTY) {
    process.stderr.write(question + "\n");
    return nextPipedLine();
  }
  return new Promise((done, fail) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (err) fail(err);
      else done(value.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new Error("Cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// ---- Image -> QR text -----------------------------------------------------------------

function run(cmd, args) {
  return new Promise((done) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => done({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
  });
}

/** Parse an uncompressed 24/32-bit BMP (what `sips -s format bmp` writes) into RGBA. */
export function parseBmp(buf) {
  if (buf.toString("latin1", 0, 2) !== "BM") throw new Error("not a BMP");
  const offset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (width <= 0 || rawHeight === 0 || (bpp !== 24 && bpp !== 32)) throw new Error("unsupported BMP");
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  let masks = { r: 0x00ff0000, g: 0x0000ff00, b: 0x000000ff };
  if (compression === 3 && headerSize >= 52) masks = { r: buf.readUInt32LE(54), g: buf.readUInt32LE(58), b: buf.readUInt32LE(62) };
  else if (compression !== 0 && compression !== 3) throw new Error("compressed BMP");
  const channel = (v, m) => {
    if (!m) return 0;
    const shift = 31 - Math.clz32(m & -m);
    return ((v & m) >>> shift) * 255 / ((m >>> shift) || 1);
  };
  const stride = Math.ceil((width * bpp) / 32) * 4;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = offset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const p = row + x * (bpp / 8);
      const o = (y * width + x) * 4;
      if (bpp === 24) {
        out[o] = buf[p + 2];
        out[o + 1] = buf[p + 1];
        out[o + 2] = buf[p];
      } else {
        const v = buf.readUInt32LE(p);
        out[o] = channel(v, masks.r);
        out[o + 1] = channel(v, masks.g);
        out[o + 2] = channel(v, masks.b);
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}

/** Decode any image to RGBA: sharp when it loads, else `sips` to BMP. */
async function loadRgba(path, workDir) {
  try {
    const sharp = (await import("sharp")).default;
    const { data, info } = await sharp(path).flatten({ background: "#ffffff" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
  } catch {
    // sharp missing, or a format it cannot read (HEIC...): let macOS convert it.
  }
  const bmp = join(workDir, "image.bmp");
  const r = await run("sips", ["-s", "format", "bmp", path, "--out", bmp]);
  if (r.code !== 0) throw new Error("that is not an image macOS can read");
  try {
    return parseBmp(await readFile(bmp));
  } finally {
    await rm(bmp, { force: true });
  }
}

/** Add a white border: a screenshot of "just the code" often has no quiet zone. */
export function padWhite({ data, width, height }, pad) {
  const w = width + 2 * pad;
  const h = height + 2 * pad;
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < height; y++) out.set(data.subarray(y * width * 4, (y + 1) * width * 4), ((y + pad) * w + pad) * 4);
  return { data: out, width: w, height: h };
}

/** QR text in the image at `path`, or null when there is none. */
export async function decodeQrImage(path) {
  const workDir = await mkdtemp(join(tmpdir(), "ready-qr-"));
  try {
    const img = await loadRgba(path, workDir);
    const first = jsQR(img.data, img.width, img.height);
    if (first?.data) return first.data;
    const padded = padWhite(img, Math.max(16, Math.round(Math.min(img.width, img.height) / 8)));
    return jsQR(padded.data, padded.width, padded.height)?.data || null;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Write the clipboard image to a 0600 temp file, decode it, delete it. */
async function qrFromClipboard() {
  const dir = await mkdtemp(join(tmpdir(), "ready-clip-"));
  const file = join(dir, "clipboard.png");
  try {
    await (await open(file, "wx", 0o600)).close();
    const posix = file.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    // READY_OSASCRIPT_CMD lets tests stand in for the clipboard.
    const r = await run(process.env.READY_OSASCRIPT_CMD || "osascript", [
      "-e", `set f to open for access POSIX file "${posix}" with write permission`,
      "-e", "try",
      "-e", "write (the clipboard as «class PNGf») to f",
      "-e", "on error e",
      "-e", "close access f",
      "-e", "error e",
      "-e", "end try",
      "-e", "close access f",
    ]);
    if (r.code !== 0) throw new Error("there is no image on the clipboard");
    return await decodeQrImage(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- Commands -------------------------------------------------------------------------

const base = (s) => String(s).replace(/\/+$/, "");

function qrHint(err) {
  const code = err instanceof MoodleError ? err.errorcode : null;
  const hints = {
    invalidkey: "the QR code has expired or was used already. Show a new QR code and run login again.",
    qrcodedisabled: "this site does not allow QR login.",
    apprequired: "the site wants the Moodle app.",
  };
  return `QR login failed (${code || "network_error"}): ${hints[code] || "show a new QR code and run login again."}`;
}

async function readQrText(opts) {
  let text = null;
  try {
    if (opts.file) {
      text = await decodeQrImage(opts.file);
      if (!text) warn("No QR code found in that image.");
    } else {
      await askLine(LOGIN_PROMPT + " ");
      text = await qrFromClipboard();
      if (!text) warn("No QR code found in the clipboard image.");
    }
  } catch (err) {
    warn(`Could not read the QR code: ${err?.message || "unknown problem"}.`);
  }
  if (!text) {
    warn("Instead, copy the text the QR code holds (a phone camera shows it) and paste it here.");
    text = await askHidden("QR text (hidden): ");
  }
  if (!text) throw new Error("No QR text given");
  remember(text);
  return text;
}

async function login(opts, site, mockSite) {
  let text = await readQrText(opts);
  const qr = parseQr(text);
  remember(qr.key);
  text = null;
  let target = site;
  if (!mockSite) {
    target = keychain.normaliseSite(qr.site);
    if (opts.site && target !== site) warn(`Note: the QR code is for ${qr.site}, not ${opts.site}. Using ${qr.site}.`);
  }
  let token;
  try {
    ({ token } = await exchangeQr(mockSite || qr.site, qr.key, qr.userid));
  } catch (err) {
    throw new Error(qrHint(err));
  }
  remember(token);
  try {
    await keychain.set(target, token);
  } finally {
    token = null;
  }
  const kept = await keychain.get(target);
  remember(kept);
  const info = await call(mockSite || target, kept, "core_webservice_get_site_info", {});
  say(`Signed in as user ${info.userid} on ${target}. Key kept in your Mac's Keychain until you run logout.`);
  return 0;
}

async function status(site, mockSite) {
  const key = await keychain.get(site);
  if (!key) {
    say(`No key stored for ${site}. Run: node scripts/moodle/session.mjs login`);
    return 1;
  }
  remember(key);
  try {
    const info = await call(mockSite || site, key, "core_webservice_get_site_info", {});
    say(`Key stored for ${site}. Moodle accepts it: user ${info.userid} on ${info.sitename || site}.`);
    return 0;
  } catch (err) {
    const code = err instanceof MoodleError ? err.errorcode || "error" : "network_error";
    say(`Key stored for ${site}, but Moodle did not accept it (${code}). Run login again, or logout.`);
    return 1;
  }
}

async function logout(site) {
  const removed = await keychain.remove(site);
  say(removed ? `Removed the key for ${site} from your Mac's Keychain.` : `No key was stored for ${site}; nothing to remove.`);
  return 0;
}

const USAGE = `Usage: node scripts/moodle/session.mjs login  [--site <url>] [--file <image>] [--mock]
       node scripts/moodle/session.mjs status [--site <url>] [--mock]
       node scripts/moodle/session.mjs logout [--site <url>] [--mock]
A test convenience for the M0 sittings: keeps the key in this Mac's Keychain until logout.
`;

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  let mock = null;
  try {
    let mockSite = null;
    if (opts.mock) {
      if (opts.site) mockSite = base(opts.site);
      else {
        const m = await import("./mock.mjs");
        mock = await m.startMock({ port: 0 });
        mockSite = mock.url;
      }
    }
    const site = keychain.normaliseSite(mockSite || opts.site || DEFAULT_SITE);
    if (opts.cmd === "login") return await login(opts, site, mockSite);
    if (opts.cmd === "status") return await status(site, mockSite);
    return await logout(site);
  } finally {
    if (mock) await mock.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      const msg = err instanceof MoodleError ? `${err.errorcode || "error"}: ${err.message}` : err?.message || String(err);
      process.stderr.write(`session: ${scrub(msg)}\n`);
      process.exit(2);
    },
  );
}

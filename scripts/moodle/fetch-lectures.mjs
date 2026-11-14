// Pull one course's lecture PDFs to a folder outside the repo (ticket M0-14).
// Node 20+, no dependencies. Only reads: it lists courses, reads course contents and
// downloads files. The key stays in memory only; it is never printed, logged or saved.
//
// Usage:
//   pbpaste | node scripts/moodle/fetch-lectures.mjs --qr                       list courses
//   pbpaste | node scripts/moodle/fetch-lectures.mjs --qr --course CS-C3120 --out ~/ready-lectures
// Options:
//   --qr            read the "View QR code" text (stdin when piped, hidden on a terminal)
//                   Without --qr: MOODLE_KEY env var, else the key itself (stdin or hidden).
//   --site <url>    site when not using --qr (default https://mycourses.aalto.fi)
//   --course <text> start of the course short name, any case
//   --out <dir>     where PDFs go; must be outside this git repository
//   --match <text>  only files whose file or module name contains this, any case
//   --max <n>       stop after n saved files (default 6)
//   --mock          run against scripts/moodle/mock.mjs (starts one, or --site for a running one)

import { existsSync } from "node:fs";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, MoodleError } from "./lib/ws.mjs";
import { exchangeQr, parseQr } from "./lib/keys.mjs";

export const DEFAULT_SITE = "https://mycourses.aalto.fi";
export const MAX_BYTES = 30 * 1024 * 1024;
export const DEFAULT_MAX = 6;
const NAME_LIMIT = 120;

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
  const o = { qr: false, mock: false, site: null, course: null, out: null, match: null, max: DEFAULT_MAX, help: false };
  const need = (i, name) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--qr") o.qr = true;
    else if (a === "--mock") o.mock = true;
    else if (a === "--site") o.site = need(++i, a);
    else if (a === "--course") o.course = need(++i, a);
    else if (a === "--out") o.out = need(++i, a);
    else if (a === "--match") o.match = need(++i, a);
    else if (a === "--max") {
      o.max = Number(need(++i, a));
      if (!Number.isInteger(o.max) || o.max < 1) throw new Error("--max needs a whole number of 1 or more");
    } else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (o.course !== null && !o.course.trim()) throw new Error("--course needs a value");
  if (o.course && !o.out) throw new Error("--out is required with --course (a folder outside the repo)");
  return o;
}

export function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Walk up from this script for a .git (folder, or file in a worktree). */
export function repoRoot(from = dirname(fileURLToPath(import.meta.url))) {
  let d = resolve(from);
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Resolve --out through the realpath of its nearest existing ancestor. */
export async function resolveOut(p) {
  const abs = resolve(expandHome(p));
  let base = abs;
  const rest = [];
  while (!existsSync(base)) {
    rest.unshift(basename(base));
    const up = dirname(base);
    if (up === base) break;
    base = up;
  }
  return join(await realpath(base), ...rest);
}

/**
 * Every enclosing git checkout, innermost first. A worktree lives inside the
 * main checkout (.claude/worktrees/...), so both count as "the repository".
 */
export function repoRoots(from = dirname(fileURLToPath(import.meta.url))) {
  const roots = [];
  let d = repoRoot(from);
  while (d) {
    roots.push(d);
    const up = dirname(d);
    if (up === d) break;
    d = repoRoot(up);
  }
  return roots;
}

export async function insideRepo(outReal, root) {
  const roots = root === undefined ? repoRoots() : root ? [root] : [];
  for (const each of roots) {
    const r = await realpath(each);
    const rel = relative(r, outReal);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}

function askHidden(question) {
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

async function readAllStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const readSecret = (q) => (process.stdin.isTTY ? askHidden(q) : readAllStdin());
const siteBase = (s) => String(s).replace(/\/+$/, "");

function qrHint(err) {
  const code = err instanceof MoodleError ? err.errorcode : null;
  const hints = {
    invalidkey: "the QR code has expired or was used already. Show a new QR code and paste again.",
    qrcodedisabled: "this site does not allow QR login.",
    apprequired: "the site wants the Moodle app.",
  };
  return `QR login failed (${code || "network_error"}): ${hints[code] || "show a new QR code and try again."}`;
}

async function getKey(opts, mockSite) {
  if (opts.qr) {
    let text = await readSecret("QR text (hidden): ");
    if (!text && mockSite) {
      const m = await import("./mock.mjs");
      text = `moodlemobile://${mockSite}?qrlogin=${m.MOCK_QR_KEY}&userid=${m.MOCK_USERID}`;
    }
    if (!text) throw new Error("No QR text given");
    remember(text);
    const qr = parseQr(text);
    remember(qr.key);
    text = null;
    const site = mockSite || qr.site;
    try {
      const { token, privatetoken } = await exchangeQr(site, qr.key, qr.userid);
      remember(token);
      remember(privatetoken);
      return { site, token };
    } catch (err) {
      throw new Error(qrHint(err));
    }
  }
  const site = mockSite || opts.site || DEFAULT_SITE;
  if (mockSite) {
    const m = await import("./mock.mjs");
    return { site, token: m.MOCK_TOKEN };
  }
  const token = process.env.MOODLE_KEY ? process.env.MOODLE_KEY.trim() : await readSecret("Key (hidden): ");
  remember(token);
  return { site, token };
}

// ---- Courses and files ----------------------------------------------------------------

/** Courses whose short name starts with `text`, any case. One exact match wins. */
export function matchCourses(courses, text) {
  const t = String(text).trim().toLowerCase();
  const hits = courses.filter((c) => String(c.shortname || "").toLowerCase().startsWith(t));
  const exact = hits.filter((c) => String(c.shortname || "").toLowerCase() === t);
  return exact.length === 1 ? exact : hits;
}

const isPdf = (c) => c && c.type === "file" && (String(c.mimetype || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(c.filename || ""));

/** Make one file name part safe: no separators or control chars, single spaces, short. */
export function safePart(s) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
}

export function fileNameFor(section, moduleName, fileName) {
  const sec = String(section ?? 0).padStart(2, "0");
  const parts = [sec, safePart(moduleName) || "untitled"];
  if (fileName !== undefined) parts.push(safePart(String(fileName).replace(/\.pdf$/i, "")) || "file");
  let name = parts.join("-");
  if (name.length > NAME_LIMIT) name = name.slice(0, NAME_LIMIT).trim();
  return `${name}.pdf`;
}

/** PDFs from resource and folder modules the student can see, in course order. */
export function collectPdfs(sections) {
  const out = [];
  (Array.isArray(sections) ? sections : []).forEach((s, i) => {
    const section = Number.isInteger(s.section) ? s.section : i;
    for (const m of s.modules || []) {
      if (m.uservisible === false) continue;
      if (m.modname !== "resource" && m.modname !== "folder") continue;
      const pdfs = (m.contents || []).filter(isPdf).filter((c) => c.fileurl);
      const inFolder = m.modname === "folder" || pdfs.length > 1;
      for (const c of pdfs) {
        out.push({
          section,
          module: m.name || "",
          filename: c.filename || "",
          filesize: Number(c.filesize) || 0,
          fileurl: c.fileurl,
          name: fileNameFor(section, m.name, inFolder ? c.filename : undefined),
        });
      }
    }
  });
  return out;
}

/** Same as the app's fileUrl(): token as a query param, on the web service file server. */
export function tokenUrl(site, url, token) {
  const s = new URL(siteBase(site) + "/");
  const u = new URL(url, s);
  if (u.origin !== s.origin) return null;
  if (!u.pathname.includes("/webservice/pluginfile.php") && u.pathname.includes("/pluginfile.php")) {
    u.pathname = u.pathname.replace("/pluginfile.php", "/webservice/pluginfile.php");
  }
  u.searchParams.set("token", token);
  return u;
}

export function human(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Download to `dest` through a .part file. Stops past `limit` bytes. Checks it is a PDF.
 * Returns the byte count. Throws a token-free Error on any problem.
 */
export async function downloadTo(url, dest, { limit = MAX_BYTES } = {}) {
  const ctrl = new AbortController();
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    throw new Error(`network error (${err?.cause?.code || err?.name || "fetch failed"})`);
  }
  const type = res.headers.get("content-type") || "";
  if (/json/i.test(type)) {
    let code = `http_${res.status}`;
    try {
      const body = await res.json();
      code = body?.errorcode || code;
    } catch {
      // keep the HTTP code
    }
    throw new Error(`Moodle said ${code}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const part = `${dest}.part`;
  const fh = await open(part, "w");
  let total = 0;
  let head = "";
  try {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > limit) {
        ctrl.abort();
        throw new Error(`over ${human(limit)} while downloading`);
      }
      if (head.length < 5) head += Buffer.from(chunk).subarray(0, 5).toString("latin1");
      await fh.write(chunk);
    }
  } catch (err) {
    await fh.close();
    await rm(part, { force: true });
    throw err instanceof Error && !/token=/i.test(err.message) ? err : new Error("download stopped");
  }
  await fh.close();
  if (!head.startsWith("%PDF")) {
    await rm(part, { force: true });
    throw new Error(`not a PDF (${type || "unknown type"})`);
  }
  await rename(part, dest);
  return total;
}

/** Where to save: the name, or name-2, -3... Same size already there means skip. */
async function pickTarget(dir, name, size) {
  const stem = name.replace(/\.pdf$/i, "");
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}.pdf`;
    const p = join(dir, candidate);
    let st = null;
    try {
      st = await stat(p);
    } catch {
      return { path: p, name: candidate, renamed: n > 1 };
    }
    if (st.isFile() && size > 0 && st.size === size) return { path: p, name: candidate, same: true };
  }
  throw new Error("too many files with this name");
}

// ---- CLI ------------------------------------------------------------------------------

const USAGE = `Usage: pbpaste | node scripts/moodle/fetch-lectures.mjs --qr [--course <start of short name> --out <dir>] [--match <text>] [--max <n>] [--mock]
Without --course it lists your courses.
`;

function listCourses(courses) {
  for (const c of courses) say(`  ${c.shortname}  ${c.fullname}`);
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // The folder check comes first: nothing is read or fetched for a folder inside the repo.
  let outDir = null;
  if (opts.out) {
    outDir = await resolveOut(opts.out);
    if (await insideRepo(outDir)) {
      warn(`Refusing --out ${outDir}: it is inside the git repository (${repoRoots().join(" or ")}). Pick a folder outside it, such as ~/ready-lectures.`);
      return 2;
    }
  }

  let mock = null;
  let token = null;
  try {
    let mockSite = null;
    if (opts.mock) {
      if (opts.site) mockSite = siteBase(opts.site);
      else {
        const m = await import("./mock.mjs");
        mock = await m.startMock({ port: 0, lectures: true });
        mockSite = mock.url;
      }
    }
    const got = await getKey(opts, mockSite);
    token = got.token;
    const site = got.site;
    if (!token) throw new Error("No key given");

    const info = await call(site, token, "core_webservice_get_site_info", {});
    if (!info?.userid) throw new Error("Site info has no user id");
    const courses = await call(site, token, "core_enrol_get_users_courses", { userid: info.userid });
    const list = Array.isArray(courses) ? courses : [];

    if (!opts.course) {
      say(`${list.length} courses:`);
      listCourses(list);
      return 0;
    }

    const hits = matchCourses(list, opts.course);
    if (hits.length === 0) {
      warn(`No course short name starts with "${opts.course}". Your courses:`);
      for (const c of list) warn(`  ${c.shortname}  ${c.fullname}`);
      return 1;
    }
    if (hits.length > 1) {
      warn(`"${opts.course}" matches ${hits.length} courses. Type more of the short name:`);
      for (const c of hits) warn(`  ${c.shortname}  ${c.fullname}`);
      return 1;
    }
    const course = hits[0];
    say(`Course: ${course.shortname}  ${course.fullname}`);

    const contents = await call(site, token, "core_course_get_contents", { courseid: course.id });
    let pdfs = collectPdfs(contents);
    if (opts.match) {
      const t = opts.match.toLowerCase();
      pdfs = pdfs.filter((f) => f.filename.toLowerCase().includes(t) || f.module.toLowerCase().includes(t));
    }
    if (!pdfs.length) {
      say(opts.match ? `No PDFs match "${opts.match}".` : "No PDFs found in this course.");
      return 0;
    }

    await mkdir(outDir, { recursive: true });
    say(`Folder: ${outDir}`);
    let saved = 0;
    let skipped = 0;
    let failed = 0;
    let i = 0;
    for (; i < pdfs.length && saved < opts.max; i++) {
      const f = pdfs[i];
      const sec = String(f.section).padStart(2, "0");
      const line = (name, size, result) => say(`${sec}  ${name}  ${human(size)}  ${result}`);
      if (f.filesize > MAX_BYTES) {
        line(f.name, f.filesize, `skipped (over ${human(MAX_BYTES)})`);
        skipped++;
        continue;
      }
      const url = tokenUrl(site, f.fileurl, token);
      if (!url) {
        line(f.name, f.filesize, "skipped (not on this site)");
        skipped++;
        continue;
      }
      const target = await pickTarget(outDir, f.name, f.filesize);
      if (target.same) {
        line(target.name, f.filesize, "skipped (already there, same size)");
        skipped++;
        continue;
      }
      try {
        const n = await downloadTo(url, target.path);
        line(target.name, n, target.renamed ? `saved (${f.name} was taken by a different file)` : "saved");
        saved++;
      } catch (err) {
        line(target.name, f.filesize, `skipped (${scrub(err?.message || "download failed")})`);
        skipped++;
        failed++;
      }
    }
    const more = pdfs.length - i;
    say(`Saved ${saved}, skipped ${skipped}${more ? `. ${more} more matched; raise --max to get them` : ""}.`);
    return failed ? 1 : 0;
  } finally {
    token = null;
    if (mock) await mock.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      const msg = err instanceof MoodleError ? `${err.errorcode || "error"}: ${err.message}` : err?.message || String(err);
      process.stderr.write(`fetch-lectures: ${scrub(msg)}\n`);
      process.exit(2);
    },
  );
}

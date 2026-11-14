// Read-only Moodle probe (ticket M0-03). Finds out what a student's key can see.
// Node 20+, no dependencies. Only reads: it never sends, changes or uploads anything.
//
// Usage:
//   node scripts/moodle/probe.mjs                  asks for the site and the key (hidden)
//   node scripts/moodle/probe.mjs --site <url>     skip the site question
//   node scripts/moodle/probe.mjs --out <dir>      where to write (default context/moodle)
//   node scripts/moodle/probe.mjs --mock           run against scripts/moodle/mock.mjs
//                                                  (starts one, or use --site for a running one)
// Non-interactive key: MOODLE_KEY env var, or piped on stdin. The key stays in memory only:
// it is never printed, logged or written to a file.
//
// Other ways to get the key (ticket M0-05), one at a time:
//   --launch-url [--passport <p>] [--scheme <s>]
//                 print the browser launch address and its passport, then stop
//   --redirect [--passport <p>]
//                 read the pasted `moodlemobile://token=...` address (hidden, or stdin),
//                 decode the key from it, then run the probe. With --passport (the one
//                 --launch-url printed) it checks Moodle's signature, md5(site + passport).
//   --qr          read the text the "View QR code" QR holds (hidden, or stdin), swap it
//                 for a key, then run the probe. The site comes from the QR text.
// With --mock these work against the mock; if nothing is pasted, they use the mock's own
// QR text or launch redirect.
//
// Writes <out>/probe-report.md and scrubbed answers to <out>/fixtures/*.json.
// Raw answers are never written.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, MoodleError } from "./lib/ws.mjs";
import { createScrubber } from "./lib/scrub.mjs";
import { decodeLaunchRedirect, exchangeQr, launchUrl, parseQr } from "./lib/keys.mjs";

export const DEFAULT_SITE = "https://mycourses.aalto.fi";
export const DEFAULT_OUT = "context/moodle";
const DAY = 24 * 60 * 60;
const SMALL_FILE_BYTES = 5 * 1024 * 1024;

/** Functions whose presence in the key's `functions` list we report (step 8). */
export const CHECK_FUNCTIONS = [
  "mod_assign_save_submission",
  "mod_assign_submit_for_grading",
  "core_files_upload",
  "mod_quiz_get_quizzes_by_courses",
  "core_calendar_get_calendar_export_token",
  "message_popup_get_popup_notifications",
];

// ---- Input --------------------------------------------------------------------------

/**
 * Read the command line. `keyFlags: true` (the probe) also accepts --qr, --redirect,
 * --launch-url, --passport and --scheme; handin-test.mjs shares this without them.
 */
export function parseArgs(argv, { keyFlags = false } = {}) {
  const opts = { mock: false, site: null, out: DEFAULT_OUT, help: false, mode: null, passport: null, scheme: "moodlemobile" };
  const modes = { "--qr": "qr", "--redirect": "redirect", "--launch-url": "launch-url" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mock") opts.mock = true;
    else if (a === "--site") opts.site = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (keyFlags && modes[a]) {
      if (opts.mode && opts.mode !== modes[a]) throw new Error("Use only one of --qr, --redirect and --launch-url");
      opts.mode = modes[a];
    } else if (keyFlags && a === "--passport") opts.passport = argv[++i];
    else if (keyFlags && a === "--scheme") opts.scheme = argv[++i];
    else throw new Error(`Unknown option: ${a}`);
  }
  if (opts.site === undefined || opts.out === undefined) throw new Error("--site and --out need a value");
  if (opts.passport === undefined || !opts.scheme) throw new Error("--passport and --scheme need a value");
  if (opts.passport && opts.mode !== "redirect" && opts.mode !== "launch-url") {
    throw new Error("--passport goes with --launch-url or --redirect");
  }
  return opts;
}

function ask(question) {
  return new Promise((done) => {
    process.stderr.write(question);
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

/** Read a line from a TTY without echoing it. */
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

async function getKey() {
  if (process.env.MOODLE_KEY) return process.env.MOODLE_KEY.trim();
  return readSecret("Key (hidden): ");
}

/** One secret line: hidden on a terminal, else everything piped on stdin. */
function readSecret(question) {
  return process.stdin.isTTY ? askHidden(question) : readAllStdin();
}

// ---- Getting the key without the Security keys page -----------------------------------

const siteBase = (site) => String(site).replace(/\/+$/, "");

/** A fresh random passport for the launch address. Not a secret. */
export function newPassport() {
  return randomBytes(8).toString("hex");
}

/**
 * Does the launch redirect's signature match this site and passport?
 * Moodle's launch.php signs md5(wwwroot + passport); like the Moodle app, http and https
 * are both accepted. With `mock`, the mock's own scheme (`mocksig` + passport) counts too.
 */
export function signatureMatches(signature, site, passport, { mock = false } = {}) {
  const b = siteBase(site);
  const sites = new Set([b, b.replace(/^https:/i, "http:"), b.replace(/^http:/i, "https:")]);
  const expected = [...sites].map((x) => createHash("md5").update(x + passport).digest("hex"));
  if (mock) expected.push(`mocksig${passport}`);
  return expected.includes(String(signature).trim());
}

/**
 * Pull `token=...` out of whatever was pasted (the bare address, or a whole console line
 * such as "Failed to launch 'moodlemobile://token=...' ..."). Returns `token=<base64>`.
 */
export function cleanRedirect(text) {
  const m = /token=([A-Za-z0-9+/=%_-]+)/.exec(String(text));
  if (!m) throw new Error("That is not a moodlemobile://token=... address");
  return `token=${m[1]}`;
}

/** Say what a QR login error means, without the key. */
function qrHint(err) {
  const code = err instanceof MoodleError ? err.errorcode : null;
  const hints = {
    invalidkey: "the QR code has expired or was used already. Show a new QR code and paste again.",
    qrcodedisabled: "this site does not allow QR login. Try the launch link (--launch-url).",
    apprequired: "the site wants the Moodle app. Try the launch link (--launch-url).",
  };
  return `QR login failed (${code || "network_error"}): ${hints[code] || "try the launch link (--launch-url) or Security keys."}`;
}

async function keyFromQr(opts, mockSite) {
  let text = await readSecret("QR text (hidden): ");
  if (!text && mockSite) {
    const m = await import("./mock.mjs");
    text = `moodlemobile://${mockSite}?qrlogin=${m.MOCK_QR_KEY}&userid=${m.MOCK_USERID}`;
  }
  if (!text) throw new Error("No QR text given");
  const qr = parseQr(text);
  text = null;
  const site = mockSite || qr.site;
  if (!mockSite && opts.site && siteBase(opts.site) !== qr.site) {
    process.stderr.write(`Note: the QR code is for ${qr.site}, not ${opts.site}. Using ${qr.site}.\n`);
  }
  try {
    const { token } = await exchangeQr(site, qr.key, qr.userid);
    return { site, token };
  } catch (err) {
    throw new Error(qrHint(err));
  }
}

async function keyFromRedirect(opts, site, mockSite) {
  let text = await readSecret("Redirect address (hidden): ");
  let passport = opts.passport;
  if (!text && mockSite) {
    // Nothing pasted: ask the mock's launch.php for its redirect, as the browser would.
    passport = passport || newPassport();
    const res = await fetch(launchUrl(mockSite, passport, opts.scheme), { redirect: "manual" });
    text = res.headers.get("location") || "";
  }
  if (!text) throw new Error("No redirect address given");
  const { signature, token } = decodeLaunchRedirect(cleanRedirect(text));
  text = null;
  if (!passport) {
    process.stderr.write("Signature not checked: add --passport <the one --launch-url printed> to check it.\n");
  } else if (signatureMatches(signature, site, passport, { mock: Boolean(mockSite) })) {
    process.stderr.write("Signature matches this site and passport.\n");
  } else {
    process.stderr.write(
      "Warning: the signature does not match this site and passport. The address may come from another launch or site. Continuing; the probe only reads.\n",
    );
  }
  return token;
}

async function printLaunchUrl(opts, site, mockSite) {
  const passport = opts.passport || newPassport();
  const url = launchUrl(site, passport, opts.scheme);
  const out = process.stdout;
  out.write("Open this address in a browser with the developer tools open (Network tab, keep the log):\n");
  out.write(`${url}\n`);
  out.write(`Passport: ${passport}\n`);
  out.write(`After she signs in, copy the ${opts.scheme}://token=... address and run:\n`);
  out.write(`  node scripts/moodle/probe.mjs --redirect --passport ${passport}\n`);
  if (mockSite) {
    const res = await fetch(url, { redirect: "manual" });
    const ok = res.status === 303 && (res.headers.get("location") || "").startsWith(`${opts.scheme}://token=`);
    out.write(ok ? "Mock: the address answers with a token redirect. This mock stops when the command ends.\n" : "Mock: the address did not redirect.\n");
    return ok ? 0 : 1;
  }
  return 0;
}

// ---- Shape of an answer --------------------------------------------------------------

/** A short description of a JSON value's structure, no values. */
export function shapeOf(v, depth = 0) {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return `[${v.length}× ${depth >= 1 ? kind(v[0]) : shapeOf(v[0], depth + 1)}]`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    if (depth >= 1) return `{${keys.length} keys}`;
    const shown = keys.slice(0, 8).map((k) => `${k}: ${kind(v[k])}`);
    return `{${shown.join(", ")}${keys.length > 8 ? `, +${keys.length - 8} more` : ""}}`;
  }
  return typeof v;
}

function kind(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === "object") return `object(${Object.keys(v).length})`;
  return typeof v;
}

// ---- Probe ---------------------------------------------------------------------------

function redactor(token) {
  return (s) => (token ? String(s ?? "").split(token).join("REDACTED") : String(s ?? ""));
}

/**
 * Run every read-only call in order. Returns { rows, facts, fixtures }.
 * `fixtures` maps a file name to an already-scrubbed answer.
 */
export async function probe(site, token, { now = Math.floor(Date.now() / 1000) } = {}) {
  const redact = redactor(token);
  const scrub = createScrubber();
  const rows = [];
  const fixtures = {};
  const facts = {};

  async function step(label, fn, params, summarize) {
    const t0 = performance.now();
    const row = { label, fn, ok: false, code: "", ms: 0, shape: "", notes: "" };
    try {
      const answer = await call(site, token, fn, params);
      row.ms = Math.round(performance.now() - t0);
      row.ok = true;
      row.shape = shapeOf(answer);
      fixtures[`${fn}.json`] = scrub(answer);
      if (summarize) row.notes = summarize(answer) || "";
      rows.push(row);
      return answer;
    } catch (err) {
      row.ms = Math.round(performance.now() - t0);
      row.code = err instanceof MoodleError ? err.errorcode || "error" : "network_error";
      row.notes = redact(err?.message || "");
      rows.push(row);
      return null;
    }
  }

  // 1. Site info
  const info = await step("Site info", "core_webservice_get_site_info", {}, (a) => {
    facts.release = a.release ?? null;
    facts.userIdPresent = a.userid !== undefined && a.userid !== null;
    facts.functions = Array.isArray(a.functions) ? a.functions.map((f) => f.name).filter(Boolean) : null;
    facts.uploadfiles = a.uploadfiles ?? null;
    facts.downloadfiles = a.downloadfiles ?? null;
    facts.usermaxuploadfilesize = a.usermaxuploadfilesize ?? null;
    const expiry = Object.keys(a).filter((k) => /expir|validuntil|lifetime/i.test(k));
    facts.keyLifetime = expiry.length ? expiry.map((k) => `${k}=${a[k]}`).join(", ") : null;
    return `functions: ${facts.functions ? facts.functions.length : "not listed"}`;
  });
  const userid = info?.userid;

  // 2. Courses
  const courses = userid
    ? await step("Enrolled courses", "core_enrol_get_users_courses", { userid }, (a) => `${Array.isArray(a) ? a.length : 0} courses`)
    : skip(rows, "Enrolled courses", "core_enrol_get_users_courses", "no user id from site info");
  const courseList = Array.isArray(courses) ? courses : [];
  const courseIds = courseList.map((c) => c.id).filter(Boolean);
  const firstCourse = courseIds[0];

  // 3. Assignments
  let firstAssignment = null;
  if (courseIds.length) {
    await step("Assignments", "mod_assign_get_assignments", { courseids: courseIds }, (a) => {
      const list = (a?.courses || []).flatMap((c) => c.assignments || []);
      firstAssignment = list[0] || null;
      facts.assignments = list.map(summarizeAssignment);
      return `${list.length} assignments`;
    });
  } else skip(rows, "Assignments", "mod_assign_get_assignments", "no courses");

  // 4. Course contents, then one small file
  let file = null;
  if (firstCourse) {
    await step("Course contents (first course)", "core_course_get_contents", { courseid: firstCourse }, (a) => {
      const files = (Array.isArray(a) ? a : [])
        .flatMap((s) => s.modules || [])
        .flatMap((m) => m.contents || [])
        .filter((c) => c.type === "file" && c.fileurl);
      file = files.filter((f) => Number(f.filesize) <= SMALL_FILE_BYTES).sort((x, y) => x.filesize - y.filesize)[0] || null;
      return `${files.length} files`;
    });
  } else skip(rows, "Course contents (first course)", "core_course_get_contents", "no courses");

  if (file) rows.push(await downloadRow(site, token, file.fileurl, redact));
  else skip(rows, "Download one small file", "(pluginfile download)", "no small file found");

  // 5. Grade items
  if (firstCourse && userid) {
    await step("Grade items (first course)", "gradereport_user_get_grade_items", { courseid: firstCourse, userid }, (a) => {
      const items = (a?.usergrades || []).flatMap((g) => g.gradeitems || []);
      const weighted = items.filter((i) => i.weightraw !== undefined && i.weightraw !== null);
      facts.weights = items.length ? `${weighted.length} of ${items.length} items have a weight` : "no grade items";
      return facts.weights;
    });
  } else skip(rows, "Grade items (first course)", "gradereport_user_get_grade_items", "no course or user id");

  // 6. Calendar, next 60 days
  await step(
    "Action events, next 60 days",
    "core_calendar_get_action_events_by_timesort",
    { timesortfrom: now, timesortto: now + 60 * DAY, limitnum: 50 },
    (a) => `${(a?.events || []).length} events`,
  );

  // 7. Submission status
  if (firstAssignment) {
    await step("Submission status (one assignment)", "mod_assign_get_submission_status", { assignid: firstAssignment.id }, (a) => {
      const s = a?.lastattempt?.submission;
      return s ? `status: ${s.status}` : "no last attempt";
    });
  } else skip(rows, "Submission status (one assignment)", "mod_assign_get_submission_status", "no assignment");

  // 8. Which functions the key may use
  facts.available = CHECK_FUNCTIONS.map((name) => ({
    name,
    present: facts.functions ? facts.functions.includes(name) : null,
  }));

  return { rows, facts, fixtures };
}

function skip(rows, label, fn, why) {
  rows.push({ label, fn, ok: false, code: "skipped", ms: 0, shape: "", notes: why });
  return null;
}

function config(a, plugin, name) {
  const c = (a.configs || []).find((x) => x.plugin === plugin && x.name === name && x.subtype === "assignsubmission");
  return c ? c.value : undefined;
}

function summarizeAssignment(a) {
  const types = [];
  if (config(a, "file", "enabled") === "1") types.push("file");
  if (config(a, "onlinetext", "enabled") === "1") types.push("online text");
  return {
    duedate: a.duedate ? new Date(a.duedate * 1000).toISOString().slice(0, 10) : "none",
    types: types.length ? types.join(" + ") : a.configs ? "none enabled" : "not in answer",
    submitButton: a.submissiondrafts === undefined ? "not in answer" : a.submissiondrafts ? "yes" : "no",
    maxFiles: config(a, "file", "maxfilesubmissions") ?? "not in answer",
    maxBytes: config(a, "file", "maxsubmissionsizebytes") ?? (a.maxsubmissionsizebytes ?? "not in answer"),
  };
}

/** GET one file with the key as `token` query param. Reports size and type only. */
async function downloadRow(site, token, fileurl, redact) {
  const row = { label: "Download one small file", fn: "(pluginfile download)", ok: false, code: "", ms: 0, shape: "", notes: "" };
  const t0 = performance.now();
  try {
    const u = new URL(fileurl, String(site).replace(/\/+$/, "") + "/");
    u.searchParams.set("token", token);
    const res = await fetch(u);
    const bytes = new Uint8Array(await res.arrayBuffer());
    row.ms = Math.round(performance.now() - t0);
    const type = res.headers.get("content-type") || "unknown";
    let errorcode = null;
    if (/json/i.test(type)) {
      try {
        const body = JSON.parse(new TextDecoder().decode(bytes));
        errorcode = body?.errorcode || (body?.error ? "error" : null);
      } catch {
        // not JSON after all; treat as a file
      }
    }
    if (!res.ok || errorcode) {
      row.code = errorcode || `http_${res.status}`;
      row.notes = `HTTP ${res.status}`;
    } else {
      row.ok = true;
      row.shape = `${bytes.length} bytes, ${type}`;
    }
  } catch (err) {
    row.ms = Math.round(performance.now() - t0);
    row.code = "network_error";
    row.notes = redact(err?.message || "");
  }
  return row;
}

// ---- Report --------------------------------------------------------------------------

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const yesNo = (v) => (v === null || v === undefined ? "not in answer" : v ? "yes" : "no");

export function renderReport({ rows, facts }, { site, when = new Date() } = {}) {
  const L = [];
  L.push("# Moodle probe report", "");
  L.push(`Site: ${site}  `, `Run: ${when.toISOString()}  `, "Read-only. Answers in `fixtures/` went through `scrub()`; raw answers were not saved.", "");
  L.push("## Calls", "");
  L.push("| # | Call | Function | Result | ms | Shape | Notes |", "|---|---|---|---|---|---|---|");
  rows.forEach((r, i) => {
    L.push(`| ${i + 1} | ${cell(r.label)} | \`${cell(r.fn)}\` | ${r.ok ? "worked" : cell(r.code)} | ${r.ms} | ${cell(r.shape)} | ${cell(r.notes)} |`);
  });
  L.push("", "## Site info", "");
  L.push("| Field | Value |", "|---|---|");
  L.push(`| release | ${cell(facts.release ?? "not in answer")} |`);
  L.push(`| user id | ${facts.userIdPresent ? "present (value kept out of this report)" : "not in answer"} |`);
  L.push(`| functions | ${facts.functions ? `${facts.functions.length} listed` : "not in answer"} |`);
  L.push(`| uploadfiles | ${yesNo(facts.uploadfiles)} |`);
  L.push(`| downloadfiles | ${yesNo(facts.downloadfiles)} |`);
  L.push(`| usermaxuploadfilesize | ${cell(facts.usermaxuploadfilesize ?? "not in answer")} |`);
  L.push(`| key lifetime | ${cell(facts.keyLifetime ?? "not exposed by get_site_info")} |`);
  if (facts.assignments) {
    L.push("", "## Assignments", "");
    L.push("| Due | Submission types | Separate Submit button (submissiondrafts) | Max files | Max bytes |", "|---|---|---|---|---|");
    for (const a of facts.assignments) {
      L.push(`| ${a.duedate} | ${cell(a.types)} | ${a.submitButton} | ${cell(a.maxFiles)} | ${cell(a.maxBytes)} |`);
    }
  }
  if (facts.weights) L.push("", `Grade weights: ${facts.weights}.`);
  L.push("", "## Functions this key may use", "");
  L.push("| Function | In list |", "|---|---|");
  for (const f of facts.available || []) {
    L.push(`| \`${f.name}\` | ${f.present === null ? "unknown (no functions list)" : f.present ? "yes" : "no"} |`);
  }
  L.push("");
  return L.join("\n");
}

async function writeOutputs(outDir, result, site) {
  const fixturesDir = join(outDir, "fixtures");
  await mkdir(fixturesDir, { recursive: true });
  for (const [name, data] of Object.entries(result.fixtures)) {
    await writeFile(join(fixturesDir, name), JSON.stringify(data, null, 2) + "\n");
  }
  const reportPath = join(outDir, "probe-report.md");
  await writeFile(reportPath, renderReport(result, { site }));
  return reportPath;
}

// ---- CLI -----------------------------------------------------------------------------

const USAGE = `Usage: node scripts/moodle/probe.mjs [--site <url>] [--out <dir>] [--mock]
       node scripts/moodle/probe.mjs --qr [--out <dir>] [--mock]
       node scripts/moodle/probe.mjs --launch-url [--site <url>] [--passport <p>] [--scheme <s>] [--mock]
       node scripts/moodle/probe.mjs --redirect [--passport <p>] [--site <url>] [--out <dir>] [--mock]
`;

async function main(argv) {
  const opts = parseArgs(argv, { keyFlags: true });
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  let mock = null;
  let site = opts.site;
  let token;
  try {
    if (opts.mock) {
      const m = await import("./mock.mjs");
      if (!site) {
        mock = await m.startMock({ port: 0 });
        site = mock.url;
      }
      if (opts.mode === "launch-url") return await printLaunchUrl(opts, site, site);
      if (opts.mode === "qr") ({ token } = await keyFromQr(opts, site));
      else if (opts.mode === "redirect") token = await keyFromRedirect(opts, site, site);
      else token = m.MOCK_TOKEN;
    } else if (opts.mode === "qr") {
      ({ site, token } = await keyFromQr(opts, null));
    } else {
      if (!site) site = process.stdin.isTTY ? (await ask(`Site [${DEFAULT_SITE}]: `)) || DEFAULT_SITE : DEFAULT_SITE;
      if (opts.mode === "launch-url") return await printLaunchUrl(opts, site, null);
      token = opts.mode === "redirect" ? await keyFromRedirect(opts, site, null) : await getKey();
    }
    if (!token) throw new Error("No key given");
    const result = await probe(site, token);
    const reportPath = await writeOutputs(resolve(opts.out), result, site);
    const worked = result.rows.filter((r) => r.ok).length;
    process.stdout.write(`${worked} of ${result.rows.length} calls worked. Report: ${reportPath}\n`);
    return result.rows[0]?.ok ? 0 : 1;
  } finally {
    token = null;
    if (mock) await mock.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`probe: ${err?.message || err}\n`);
      process.exit(2);
    },
  );
}

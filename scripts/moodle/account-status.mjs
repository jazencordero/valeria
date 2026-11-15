// Save her hand-in status and grades for all her courses (ticket M0-16).
// Node 20+, no dependencies. Only reads: site info, her courses, assignments, the status
// of each assignment and her grade items. The key stays in memory only; it is never
// printed, logged or saved.
//
// Usage:
//   node scripts/moodle/account-status.mjs                        after session.mjs login
//   node scripts/moodle/account-status.mjs --out ~/ready-account
//   pbpaste | node scripts/moodle/account-status.mjs --qr
// Options:
//   --qr          read the "View QR code" text (stdin when piped, hidden on a terminal)
//                 Without --qr: MOODLE_KEY env var, else a piped key, else the key
//                 `session.mjs login` kept in the Keychain for the site, else hidden prompt.
//   --site <url>  site when not using --qr (default https://mycourses.aalto.fi)
//   --out <dir>   where the files go (default ~/ready-account); must be outside this repo
//   --mock        run against scripts/moodle/mock.mjs (starts one, or --site for a running one)
//
// Writes one <course short name>.json per course and summary.txt (the printed table).
// Kept: her own status, dates, file names and sizes, her own grades. Left out: feedback
// text, file URLs, and anything about other users (other entries in the grade report,
// group members).

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { call, MoodleError } from "./lib/ws.mjs";
import { exchangeQr, parseQr } from "./lib/keys.mjs";
import * as keychain from "./lib/keychain.mjs";
import { DEFAULT_SITE, human, insideRepo, repoRoots, resolveOut, safePart } from "./fetch-lectures.mjs";

export const DEFAULT_OUT = "~/ready-account";

// ---- Secrets: everything printed or written goes through scrub() ----------------------

const secrets = new Set();
function remember(s) {
  if (s && String(s).length >= 4) secrets.add(String(s));
}
export function scrub(text) {
  let out = String(text ?? "");
  for (const s of secrets) out = out.split(s).join("REDACTED");
  return out.replace(/((?:ws|private)?token|qrlogin)=[^&\s'"]+/gi, "$1=REDACTED");
}
const say = (s) => process.stdout.write(scrub(s) + "\n");
const warn = (s) => process.stderr.write(scrub(s) + "\n");

// ---- Input ----------------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { qr: false, mock: false, site: null, out: DEFAULT_OUT, help: false };
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
    else if (a === "--out") o.out = need(++i, a);
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!o.out.trim()) throw new Error("--out needs a value");
  return o;
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

// Same order as fetch-lectures.mjs: --qr, MOODLE_KEY, piped key, Keychain, hidden prompt.
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
  let token = process.env.MOODLE_KEY ? process.env.MOODLE_KEY.trim() : "";
  if (!token && !process.stdin.isTTY) token = await readAllStdin();
  if (!token) {
    token = (await keychain.get(site).catch(() => null)) || "";
    if (token) warn(`Using the key in your Mac's Keychain for ${keychain.normaliseSite(site)}.`);
  }
  if (!token && process.stdin.isTTY) token = await askHidden("Key (hidden): ");
  remember(token);
  return { site, token };
}

// ---- Reading Moodle's answers ---------------------------------------------------------

/** Unix seconds to ISO text; 0, null or junk is null. */
export function iso(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

const STATUSES = new Set(["new", "draft", "submitted", "reopened"]);

/**
 * One assignment row from its entry in mod_assign_get_assignments and its
 * mod_assign_get_submission_status answer. On a group assignment the group's
 * `teamsubmission` is the one that counts (her own stays "new").
 */
export function assignmentRow(a, statusAnswer) {
  const last = statusAnswer?.lastattempt;
  const sub = last?.teamsubmission ?? last?.submission ?? null;
  const status = sub && STATUSES.has(sub.status) ? sub.status : "none";
  const files = (sub?.plugins ?? [])
    .filter((p) => p?.type === "file")
    .flatMap((p) => p.fileareas ?? [])
    .filter((area) => area?.area === "submission_files")
    .flatMap((area) => area.files ?? [])
    .map((f) => ({ name: String(f.filename ?? ""), size: Number(f.filesize) || 0 }));
  const gradingstatus = typeof last?.gradingstatus === "string" ? last.gradingstatus : null;
  return {
    id: a.id,
    cmid: a.cmid ?? null,
    name: String(a.name ?? ""),
    dueAt: iso(a.duedate),
    cutoffAt: iso(a.cutoffdate),
    status,
    graded: last?.graded === true || gradingstatus === "graded" || gradingstatus === "released",
    gradingstatus,
    submittedAt: status === "submitted" ? iso(sub.timemodified) : null,
    files,
    requiresSubmitPress: Number(a.submissiondrafts) === 1,
    isGroup: Boolean(last?.teamsubmission) || Number(a.teamsubmission) === 1,
  };
}

const TOTALS = new Set(["category", "course"]);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Her grade items in one course. Only the entry for `userid` is read; others are ignored. */
export function gradeRows(answer, userid) {
  const mine = (answer?.usergrades ?? []).find((u) => Number(u?.userid) === Number(userid));
  return (mine?.gradeitems ?? []).map((g) => {
    const score = num(g.graderaw);
    const max = num(g.grademax);
    const min = num(g.grademin) ?? 0;
    const isTotal = TOTALS.has(g.itemtype);
    return {
      id: g.id,
      name: g.itemname || (g.itemtype === "course" ? "Course total" : isTotal ? "Category total" : ""),
      itemtype: String(g.itemtype ?? ""),
      itemmodule: g.itemmodule ?? null,
      // Only used to match a grade to its assignment; dropped before writing.
      iteminstance: g.iteminstance ?? null,
      score,
      max,
      // Moodle's own formula; we do not read the site's formatted text.
      percent: score !== null && max !== null && max > min ? ((score - min) / (max - min)) * 100 : null,
      weight: num(g.weightraw),
      hidden: Boolean(g.gradeishidden || g.gradehiddenbydate),
      gradedAt: iso(g.gradedategraded),
      isTotal,
    };
  });
}

const errText = (err) =>
  scrub(err instanceof MoodleError ? `${err.errorcode || "error"}: ${err.message}` : err?.message || String(err));

// ---- Table ----------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, "0");
function when(isoText) {
  if (!isoText) return "-";
  const d = new Date(isoText);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const n2 = (x) => String(Number(x.toFixed(2)));
function gradeText(g) {
  if (!g) return "-";
  if (g.score === null) return g.hidden ? "hidden" : "-";
  return `${n2(g.score)}${g.max !== null ? `/${n2(g.max)}` : ""}${g.hidden ? " (hidden)" : ""}`;
}
function statusText(a) {
  if (a.error) return `error (${a.error})`;
  let s = a.status;
  if (a.graded) s += ", graded";
  if (a.files.length) s += ` (${a.files.length} file${a.files.length > 1 ? "s" : ""}, ${human(a.files.reduce((t, f) => t + f.size, 0))})`;
  if (a.isGroup) s += " [group]";
  return s;
}
const cut = (s, n = 48) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

export function tableLines(rows) {
  const head = ["Course", "Assignment", "Due", "Status", "Grade"];
  const all = [head, ...rows.map((r) => r.map((c) => cut(String(c))))];
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...all.slice(1).map(line)];
}

/** Table rows for one course: assignments, then other graded items, then totals. */
function courseRows(file) {
  const short = file.course.shortname;
  const rows = [];
  const used = new Set();
  for (const a of file.assignments) {
    const g = file.grades.find((x) => x.itemmodule === "assign" && x.iteminstance === a.id);
    if (g) used.add(g.id);
    rows.push([short, a.name, when(a.dueAt), statusText(a), gradeText(g)]);
  }
  for (const g of file.grades.filter((x) => !used.has(x.id) && !x.isTotal)) rows.push([short, g.name || "(grade item)", "-", "-", gradeText(g)]);
  for (const g of file.grades.filter((x) => x.isTotal && x.itemtype === "course")) rows.push([short, g.name, "-", "-", gradeText(g)]);
  for (const e of file.errors) rows.push([short, `(${e.call})`, "-", `error (${e.message})`, "-"]);
  if (!rows.length) rows.push([short, "(no assignments or grades)", "-", "-", "-"]);
  return rows;
}

// ---- CLI ------------------------------------------------------------------------------

const USAGE = `Usage: node scripts/moodle/account-status.mjs [--out <dir>] [--qr] [--site <url>] [--mock]
Saves her hand-in status and grades for every course to --out (default ${DEFAULT_OUT}).
`;

/** A file name per course: the safe short name, with the id added if two would clash. */
function fileNames(courses) {
  const taken = new Set(["summary"]);
  const out = new Map();
  for (const c of courses) {
    let stem = safePart(c.shortname) || `course-${c.id}`;
    if (taken.has(stem.toLowerCase())) stem = `${stem}-${c.id}`;
    taken.add(stem.toLowerCase());
    out.set(c.id, `${stem}.json`);
  }
  return out;
}

async function writePrivate(path, text) {
  await writeFile(path, scrub(text), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // The folder check comes first: nothing is read or fetched for a folder inside the repo.
  const outDir = await resolveOut(opts.out);
  if (await insideRepo(outDir)) {
    warn(`Refusing --out ${outDir}: it is inside the git repository (${repoRoots().join(" or ")}). Pick a folder outside it, such as ${DEFAULT_OUT}.`);
    return 2;
  }

  let mock = null;
  let token = null;
  try {
    let mockSite = null;
    if (opts.mock) {
      if (opts.site) mockSite = siteBase(opts.site);
      else {
        const m = await import("./mock.mjs");
        mock = await m.startMock({ port: 0, account: true });
        mockSite = mock.url;
      }
    }
    const got = await getKey(opts, mockSite);
    token = got.token;
    const site = got.site;
    if (!token) throw new Error("No key given");
    const ws = (fn, params) => call(site, token, fn, params);

    const info = await ws("core_webservice_get_site_info", {});
    const userid = Number(info?.userid);
    if (!userid) throw new Error("Site info has no user id");
    const enrolled = await ws("core_enrol_get_users_courses", { userid });
    const courses = (Array.isArray(enrolled) ? enrolled : []).filter((c) => Number.isInteger(c?.id));
    say(`${courses.length} courses for user ${userid}.`);

    // One call for every course's assignments. If it fails, each course records the error.
    let byCourse = new Map();
    let assignError = null;
    if (courses.length) {
      try {
        const answer = await ws("mod_assign_get_assignments", { courseids: courses.map((c) => c.id) });
        byCourse = new Map((answer?.courses ?? []).map((c) => [Number(c.id), c.assignments ?? []]));
      } catch (err) {
        assignError = errText(err);
      }
    }

    await mkdir(outDir, { recursive: true, mode: 0o700 });
    const names = fileNames(courses);
    const tableRows = [];
    let nAssign = 0;
    let nGrades = 0;
    let nErrors = 0;

    for (const c of courses) {
      const file = { course: { id: c.id, shortname: String(c.shortname ?? ""), fullname: String(c.fullname ?? "") }, assignments: [], grades: [], errors: [] };
      if (assignError) file.errors.push({ call: "mod_assign_get_assignments", message: assignError });

      for (const a of byCourse.get(c.id) ?? []) {
        try {
          const status = await ws("mod_assign_get_submission_status", { assignid: a.id });
          file.assignments.push(assignmentRow(a, status));
        } catch (err) {
          const row = assignmentRow(a, null);
          file.assignments.push({ ...row, status: null, graded: false, error: errText(err) });
        }
      }

      try {
        const answer = await ws("gradereport_user_get_grade_items", { courseid: c.id, userid });
        file.grades = gradeRows(answer, userid);
      } catch (err) {
        file.errors.push({ call: "gradereport_user_get_grade_items", message: errText(err) });
      }

      tableRows.push(...courseRows(file));
      nAssign += file.assignments.length;
      nGrades += file.grades.length;
      nErrors += file.errors.length + file.assignments.filter((a) => a.error).length;

      const written = {
        ...file,
        grades: file.grades.map((g) => {
          const copy = { ...g };
          delete copy.iteminstance;
          return copy;
        }),
      };
      await writePrivate(join(outDir, names.get(c.id)), JSON.stringify(written, null, 2) + "\n");
    }

    const lines = tableLines(tableRows);
    await writePrivate(join(outDir, "summary.txt"), lines.join("\n") + "\n");
    for (const l of lines) say(l);
    say(`Folder: ${outDir}`);
    say(`Saved ${courses.length} courses, ${nAssign} assignments, ${nGrades} grade items. Errors: ${nErrors}.`);
    return nErrors ? 1 : 0;
  } finally {
    token = null;
    if (mock) await mock.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`account-status: ${errText(err)}\n`);
      process.exit(2);
    },
  );
}

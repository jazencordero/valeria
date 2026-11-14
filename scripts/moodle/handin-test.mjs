// Hand-in test (ticket M0-04). She picks one assignment, confirms it by typing its name,
// and hands in one file she names. Node 20+, no dependencies.
//
// Usage:
//   node scripts/moodle/handin-test.mjs                  asks for the site and the key (hidden)
//   node scripts/moodle/handin-test.mjs --site <url>     skip the site question
//   node scripts/moodle/handin-test.mjs --out <dir>      where the report is (default context/moodle)
//   node scripts/moodle/handin-test.mjs --mock           run against scripts/moodle/mock.mjs
//                                                        (starts one, or use --site for a running one)
// Non-interactive key: MOODLE_KEY env var, or the first line on stdin. The answers to the
// questions come on the lines after it. The key stays in memory only: it is never printed,
// logged or written to a file.
//
// Writes nothing to Moodle until she types the assignment's name. Submits for grading only
// if she then types SUBMIT. Appends what happened to <out>/probe-report.md, without
// assignment names, ids, file names or personal data.
// File uploads only: an online-text assignment is reported as "not tested".

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { call, upload, MoodleError } from "./lib/ws.mjs";
import { DEFAULT_SITE, parseArgs } from "./probe.mjs"; // --out defaults to context/moodle there

// ---- Reading the assignment ----------------------------------------------------------

function config(a, plugin, name) {
  const c = (a.configs || []).find((x) => x.plugin === plugin && x.name === name && x.subtype === "assignsubmission");
  return c ? c.value : undefined;
}

/** "file", "onlinetext", "both", "none" or "unknown" (no configs in the answer). */
export function submissionKind(a) {
  if (!a.configs) return "unknown";
  const file = config(a, "file", "enabled") === "1";
  const text = config(a, "onlinetext", "enabled") === "1";
  if (file && text) return "both";
  if (file) return "file";
  if (text) return "onlinetext";
  return "none";
}

/** The capitals line for step 1. */
export function draftsLine(a) {
  if (a.submissiondrafts === undefined || a.submissiondrafts === null) {
    return "MOODLE DID NOT SAY WHETHER SAVING A FILE HERE COUNTS AS HANDING IN.";
  }
  return Number(a.submissiondrafts)
    ? "SAVING A FILE HERE STAYS A DRAFT UNTIL SUBMIT IS PRESSED."
    : "SAVING A FILE HERE COUNTS AS HANDING IN.";
}

function dueText(a) {
  return a.duedate ? new Date(a.duedate * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "no due date";
}

/** Warnings arrays (save / submit answers) mean the call did not do its job. */
function throwOnWarnings(answer) {
  const list = Array.isArray(answer) ? answer : answer?.warnings;
  if (Array.isArray(list) && list.length) {
    const w = list[0];
    throw new MoodleError({ message: w.message, errorcode: w.warningcode || "warning" });
  }
  return answer;
}

function storedFiles(status) {
  const plugins = status?.lastattempt?.submission?.plugins || [];
  return plugins
    .filter((p) => p.type === "file")
    .flatMap((p) => p.fileareas || [])
    .flatMap((fa) => fa.files || [])
    .map((f) => f.filename)
    .filter(Boolean);
}

// ---- The flow ------------------------------------------------------------------------

/**
 * Run the hand-in test. `ask(question)` resolves to her typed line (null at end of input);
 * `print(line)` shows a line. Returns { rows, code }. Each row is one step for the report.
 */
export async function handinTest(site, token, { ask, print, readFileFn = readFile }) {
  const rows = [];
  const redact = (s) => (token ? String(s ?? "").split(token).join("REDACTED") : String(s ?? ""));
  const failCode = (err) => (err instanceof MoodleError ? err.errorcode || "error" : err?.code === "ENOENT" ? "file_not_found" : "network_error");

  async function step(label, fn, work, summarize) {
    try {
      const answer = await work();
      rows.push({ label, fn, result: "worked", notes: summarize ? summarize(answer) || "" : "" });
      return { ok: true, answer };
    } catch (err) {
      const code = failCode(err);
      rows.push({ label, fn, result: code, notes: redact(err?.message || "") });
      print(`${label}: failed (${code}). ${redact(err?.message || "")}`);
      return { ok: false };
    }
  }
  const note = (label, fn, result, notes = "") => rows.push({ label, fn, result, notes });

  // Read what there is to pick from.
  const info = await step("Site info", "core_webservice_get_site_info", () => call(site, token, "core_webservice_get_site_info"));
  if (!info.ok) return { rows, code: 1 };
  const courses = await step("Enrolled courses", "core_enrol_get_users_courses", () =>
    call(site, token, "core_enrol_get_users_courses", { userid: info.answer.userid }),
  );
  if (!courses.ok) return { rows, code: 1 };
  const courseIds = (courses.answer || []).map((c) => c.id).filter(Boolean);
  if (!courseIds.length) {
    print("No courses found.");
    note("Pick an assignment", "(prompt)", "stopped", "no courses");
    return { rows, code: 1 };
  }
  const assigns = await step("Assignments", "mod_assign_get_assignments", () =>
    call(site, token, "mod_assign_get_assignments", { courseids: courseIds }),
  );
  if (!assigns.ok) return { rows, code: 1 };
  const list = (assigns.answer?.courses || []).flatMap((c) =>
    (c.assignments || []).map((a) => ({ ...a, courseName: c.fullname || c.shortname || "" })),
  );
  if (!list.length) {
    print("No assignments found.");
    note("Pick an assignment", "(prompt)", "stopped", "no assignments");
    return { rows, code: 1 };
  }

  // Pick one.
  print("");
  list.forEach((a, i) => print(`${i + 1}. ${a.name} (${a.courseName}), due ${dueText(a)}`));
  const pick = Number((await ask("Number of the assignment to test: ")) ?? "");
  const a = Number.isInteger(pick) && pick >= 1 && pick <= list.length ? list[pick - 1] : null;
  if (!a) {
    print("No such number. Nothing was sent.");
    note("Pick an assignment", "(prompt)", "stopped", "no valid number typed");
    return { rows, code: 1 };
  }
  const kind = submissionKind(a);
  note("Pick an assignment", "(prompt)", "worked", `submission types: ${kind}; submissiondrafts: ${a.submissiondrafts ?? "not in answer"}`);

  // Step 1: show it.
  print("");
  print(`Assignment: ${a.name}`);
  print(`Course:     ${a.courseName}`);
  print(`Due:        ${dueText(a)}`);
  print(draftsLine(a));
  if (kind === "onlinetext" || kind === "none") {
    print("This assignment takes no file uploads. Online-text hand-ins are not tested. Nothing was sent.");
    note("Hand in", "(none)", "not tested", kind === "onlinetext" ? "online-text assignment" : "no submission type enabled");
    return { rows, code: 0 };
  }

  // Step 2: she types the name.
  const typed = await ask("Type the assignment's name to continue: ");
  if ((typed ?? "").trim() !== String(a.name).trim()) {
    print("The name did not match. Nothing was sent.");
    note("Confirm by typing the name", "(prompt)", "stopped", "name did not match; no write calls made");
    return { rows, code: 1 };
  }
  note("Confirm by typing the name", "(prompt)", "worked");

  // Step 3: upload, save, read back.
  const path = ((await ask("Path of the file to hand in: ")) ?? "").trim();
  if (!path) {
    print("No file given. Nothing was sent.");
    note("Read the file", "(local)", "stopped", "no path typed");
    return { rows, code: 1 };
  }
  const file = await step("Read the file", "(local)", () => readFileFn(path), (b) => `${b.length} bytes`);
  if (!file.ok) return { rows, code: 1 };
  const up = await step("Upload to draft area", "upload.php", () => upload(site, token, file.answer, basename(path)));
  if (!up.ok) return { rows, code: 1 };
  const saved = await step("Save submission", "mod_assign_save_submission", async () =>
    throwOnWarnings(
      await call(site, token, "mod_assign_save_submission", { assignmentid: a.id, plugindata: { files_filemanager: up.answer } }),
    ),
  );
  if (!saved.ok) return { rows, code: 1 };
  const status = await step(
    "Read submission status",
    "mod_assign_get_submission_status",
    () => call(site, token, "mod_assign_get_submission_status", { assignid: a.id }),
    (s) => `status: ${s?.lastattempt?.submission?.status ?? "not in answer"}; files stored: ${storedFiles(s).length}`,
  );
  if (status.ok) {
    const files = storedFiles(status.answer);
    print(`Stored file: ${files.length ? files.join(", ") : "none listed"}`);
    print(`State:       ${status.answer?.lastattempt?.submission?.status ?? "not in answer"}`);
  }

  // Step 4: submit only on SUBMIT.
  const confirm = await ask("Type SUBMIT to submit it for grading, anything else to stop here: ");
  if ((confirm ?? "").trim() !== "SUBMIT") {
    print("Not submitted for grading.");
    note("Submit for grading", "mod_assign_submit_for_grading", "not run", "SUBMIT was not typed");
    return { rows, code: 0 };
  }
  const sub = await step("Submit for grading", "mod_assign_submit_for_grading", async () =>
    throwOnWarnings(
      await call(site, token, "mod_assign_submit_for_grading", { assignmentid: a.id, acceptsubmissionstatement: 1 }),
    ),
  );
  if (!sub.ok) return { rows, code: 1 };
  const after = await step(
    "Read submission status after submit",
    "mod_assign_get_submission_status",
    () => call(site, token, "mod_assign_get_submission_status", { assignid: a.id }),
    (s) => `status: ${s?.lastattempt?.submission?.status ?? "not in answer"}`,
  );
  if (after.ok) print(`State:       ${after.answer?.lastattempt?.submission?.status ?? "not in answer"}`);
  return { rows, code: 0 };
}

// ---- Report --------------------------------------------------------------------------

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderSection(rows, { site, when = new Date() } = {}) {
  const L = ["", "## Hand-in test", ""];
  L.push(`Site: ${site}  `, `Run: ${when.toISOString()}  `, "Assignment names, ids and file names are kept out of this report.", "");
  L.push("| # | Step | Function | Result | Notes |", "|---|---|---|---|---|");
  rows.forEach((r, i) => L.push(`| ${i + 1} | ${cell(r.label)} | \`${cell(r.fn)}\` | ${cell(r.result)} | ${cell(r.notes)} |`));
  L.push("");
  return L.join("\n");
}

async function appendReport(outDir, rows, site) {
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, "probe-report.md");
  await appendFile(path, renderSection(rows, { site }));
  return path;
}

// ---- CLI -----------------------------------------------------------------------------

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

/** One reader for every typed line, so piped stdin can answer each question in turn. */
function lineReader() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const it = rl[Symbol.asyncIterator]();
  return {
    async ask(question) {
      process.stderr.write(question);
      const { value, done } = await it.next();
      if (!process.stdin.isTTY) process.stderr.write("\n");
      return done ? null : value.replace(/\r$/, "");
    },
    close: () => rl.close(),
  };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write("Usage: node scripts/moodle/handin-test.mjs [--site <url>] [--out <dir>] [--mock]\n");
    return 0;
  }
  let mock = null;
  let site = opts.site;
  let token;
  let reader = null;
  try {
    if (opts.mock) {
      const m = await import("./mock.mjs");
      if (!site) {
        mock = await m.startMock({ port: 0, handin: true });
        site = mock.url;
      }
      token = m.MOCK_TOKEN;
      reader = lineReader();
    } else if (process.env.MOODLE_KEY) {
      token = process.env.MOODLE_KEY.trim();
      reader = lineReader();
      if (!site) site = process.stdin.isTTY ? (await reader.ask(`Site [${DEFAULT_SITE}]: `)) || DEFAULT_SITE : DEFAULT_SITE;
    } else if (process.stdin.isTTY) {
      if (!site) {
        const r = lineReader();
        site = (await r.ask(`Site [${DEFAULT_SITE}]: `)) || DEFAULT_SITE;
        r.close();
      }
      token = await askHidden("Key (hidden): ");
      reader = lineReader();
    } else {
      if (!site) site = DEFAULT_SITE;
      reader = lineReader();
      token = ((await reader.ask("")) ?? "").trim();
    }
    if (!token) throw new Error("No key given");

    const print = (line) => process.stdout.write(`${line}\n`);
    const { rows, code } = await handinTest(site, token, { ask: reader.ask, print });
    const reportPath = await appendReport(resolve(opts.out), rows, site);
    print(`Report appended: ${reportPath}`);
    return code;
  } finally {
    token = null;
    reader?.close();
    if (mock) await mock.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`handin-test: ${err?.message || err}\n`);
      process.exit(2);
    },
  );
}

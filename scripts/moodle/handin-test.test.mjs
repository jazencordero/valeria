import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, MOCK_TOKEN } from "./mock.mjs";
import { draftsLine, submissionKind } from "./handin-test.mjs";

const HANDIN = fileURLToPath(new URL("./handin-test.mjs", import.meta.url));
const WRITES = ["upload", "mod_assign_save_submission", "mod_assign_submit_for_grading"];
// Mock list order: 1 = Problem set 1 (drafts on), 2 = Problem set 2 (drafts off), 3 = Lab 1 (online text).

let mock;
let work;
const dirs = [];

before(async () => {
  mock = await startMock({ port: 0, handin: true });
  work = await tempDir();
  await writeFile(join(work, "answers.pdf"), "invented test bytes");
});

beforeEach(() => {
  mock.calls.length = 0;
});

after(async () => {
  await mock.close();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), "handin-test-"));
  dirs.push(d);
  return d;
}

function run(args, { env = {}, lines = [] } = {}) {
  return new Promise((done) => {
    const child = execFile(process.execPath, [HANDIN, ...args], { env: { ...process.env, MOODLE_KEY: "", ...env } }, (err, stdout, stderr) =>
      done({ code: err ? err.code : 0, stdout, stderr }),
    );
    child.stdin.end(lines.map((l) => `${l}\n`).join(""));
  });
}

const count = (fn) => mock.calls.filter((c) => c.fn === fn).length;
const writes = () => mock.calls.filter((c) => WRITES.includes(c.fn));

async function handin(lines, extra = {}) {
  const out = await tempDir();
  const r = await run(["--mock", "--site", mock.url, "--out", out], { lines, ...extra });
  const report = await readFile(join(out, "probe-report.md"), "utf8");
  for (const s of [r.stdout, r.stderr, report]) assert.ok(!s.includes(MOCK_TOKEN), "token never printed or written");
  return { ...r, report, out };
}

test("step 1 shows name, course, due date and the drafts line in capitals", async () => {
  const r = await handin(["1", "wrong"]);
  assert.match(r.stdout, /Assignment: Problem set 1/);
  assert.match(r.stdout, /Course: {5}Linear Algebra Basics/);
  assert.match(r.stdout, /Due: {8}\d{4}-\d\d-\d\d/);
  assert.ok(r.stdout.includes("SAVING A FILE HERE STAYS A DRAFT UNTIL SUBMIT IS PRESSED."));

  const r2 = await handin(["2", "wrong"]);
  assert.ok(r2.stdout.includes("SAVING A FILE HERE COUNTS AS HANDING IN."));
});

test("a wrong name at step 2 makes zero write calls", async () => {
  const r = await handin(["1", "Problem set 2", join(work, "answers.pdf"), "SUBMIT"]);
  assert.equal(r.code, 1);
  assert.deepEqual(writes(), [], "no upload, no save, no submit");
  assert.ok(r.stdout.includes("Nothing was sent."));
  assert.match(r.report, /Confirm by typing the name .*\| stopped \|/);
});

test("end of input at step 2 also makes zero write calls", async () => {
  const r = await handin(["1"]);
  assert.equal(r.code, 1);
  assert.deepEqual(writes(), []);
});

test("the right name makes exactly one upload and one save, then reads the status", async () => {
  const r = await handin(["1", "Problem set 1", join(work, "answers.pdf"), "no"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(count("upload"), 1);
  assert.equal(count("mod_assign_save_submission"), 1);
  assert.equal(count("mod_assign_submit_for_grading"), 0, "not submitted without SUBMIT");
  const save = mock.calls.find((c) => c.fn === "mod_assign_save_submission");
  assert.equal(save.params.assignmentid, "9001");
  assert.equal(save.params["plugindata[files_filemanager]"], "777001", "draft item id from the upload");
  assert.ok(count("mod_assign_get_submission_status") >= 1);
  assert.match(r.stdout, /Stored file: answers\.pdf/);
  assert.match(r.stdout, /State: +draft/);
  assert.match(r.stdout, /Not submitted for grading/);
});

test("submit_for_grading is called only after SUBMIT, with the statement accepted", async () => {
  const r = await handin(["1", "Problem set 1", join(work, "answers.pdf"), "SUBMIT"]);
  assert.equal(r.code, 0, r.stderr);
  const subs = mock.calls.filter((c) => c.fn === "mod_assign_submit_for_grading");
  assert.equal(subs.length, 1);
  assert.equal(subs[0].params.assignmentid, "9001");
  assert.equal(subs[0].params.acceptsubmissionstatement, "1");
  const iSave = mock.calls.findIndex((c) => c.fn === "mod_assign_save_submission");
  const iSub = mock.calls.findIndex((c) => c.fn === "mod_assign_submit_for_grading");
  assert.ok(iSave < iSub, "save comes before submit");
  assert.match(r.stdout, /State: +submitted/);
  assert.match(r.report, /Submit for grading \| `mod_assign_submit_for_grading` \| worked/);
});

test("anything other than SUBMIT does not call submit_for_grading", async () => {
  for (const typed of ["submit", "yes", "", " SUBMITT"]) {
    mock.calls.length = 0;
    const r = await handin(["1", "Problem set 1", join(work, "answers.pdf"), typed]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(count("mod_assign_submit_for_grading"), 0, `typed ${JSON.stringify(typed)}`);
    assert.equal(count("upload"), 1);
  }
});

test("an online-text assignment is reported as not tested and nothing is written", async () => {
  const r = await handin(["3", "Lab 1: linked lists"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(writes(), []);
  assert.match(r.report, /\| not tested \| online-text assignment \|/);
});

test("the report is appended, never overwritten, and holds no names or ids", async () => {
  const out = await tempDir();
  const earlier = "# Moodle probe report\n\nEarlier probe content.\n";
  await writeFile(join(out, "probe-report.md"), earlier);
  const r = await run(["--mock", "--site", mock.url, "--out", out], {
    lines: ["1", "Problem set 1", join(work, "answers.pdf"), "SUBMIT"],
  });
  assert.equal(r.code, 0, r.stderr);
  const report = await readFile(join(out, "probe-report.md"), "utf8");
  assert.ok(report.startsWith(earlier), "earlier content kept");
  assert.ok(report.includes("## Hand-in test"));
  for (const label of ["Upload to draft area", "Save submission", "Read submission status", "Submit for grading"]) {
    assert.match(report, new RegExp(`\\| ${label} \\| .* \\| worked \\|`), `${label} worked`);
  }
  for (const bad of ["Problem set 1", "Linear Algebra Basics", "answers.pdf", "9001", "777001", "student42", "Test Student"]) {
    assert.ok(!report.includes(bad), `report must not contain ${bad}`);
  }
});

test("key from MOODLE_KEY or the first stdin line, never echoed; a wrong key writes nothing", async () => {
  for (const how of ["env", "stdin"]) {
    mock.calls.length = 0;
    const out = await tempDir();
    const answers = ["1", "Problem set 1", join(work, "answers.pdf"), "no"];
    const r = await run(["--site", mock.url, "--out", out], how === "env" ? { env: { MOODLE_KEY: MOCK_TOKEN }, lines: answers } : { lines: [MOCK_TOKEN, ...answers] });
    assert.equal(r.code, 0, `${how}: ${r.stderr}`);
    assert.ok(!r.stdout.includes(MOCK_TOKEN) && !r.stderr.includes(MOCK_TOKEN), `${how}: token never printed`);
    assert.equal(count("upload"), 1, how);
  }

  mock.calls.length = 0;
  const out = await tempDir();
  const r = await run(["--site", mock.url, "--out", out], { env: { MOODLE_KEY: "wrongkey" }, lines: ["1", "Problem set 1"] });
  assert.equal(r.code, 1);
  assert.deepEqual(writes(), []);
  const report = await readFile(join(out, "probe-report.md"), "utf8");
  assert.match(report, /invalidtoken/);
  assert.ok(!report.includes("wrongkey") && !r.stdout.includes("wrongkey") && !r.stderr.includes("wrongkey"));
});

test("--mock starts its own mock when no site is given", async () => {
  const out = await tempDir();
  const r = await run(["--mock", "--out", out], { lines: ["2", "Problem set 2", join(work, "answers.pdf"), "no"] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /State: +submitted/, "drafts off: saving counts as handing in");
});

test("helpers read submission types and submissiondrafts", () => {
  assert.equal(submissionKind({}), "unknown");
  assert.equal(submissionKind({ configs: [{ plugin: "file", subtype: "assignsubmission", name: "enabled", value: "1" }] }), "file");
  assert.match(draftsLine({}), /DID NOT SAY/);
  assert.match(draftsLine({ submissiondrafts: 0 }), /COUNTS AS HANDING IN/);
  assert.match(draftsLine({ submissiondrafts: 1 }), /STAYS A DRAFT/);
});

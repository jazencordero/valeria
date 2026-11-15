import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, MOCK_TOKEN, MOCK_PRIVATE_TOKEN, MOCK_QR_KEY, MOCK_USERID, ACCOUNT_FEEDBACK } from "./mock.mjs";
import { assignmentRow, gradeRows } from "./account-status.mjs";
import { repoRoot } from "./fetch-lectures.mjs";

const SCRIPT = fileURLToPath(new URL("./account-status.mjs", import.meta.url));

let mock;
let qr;
const dirs = [];

before(async () => {
  mock = await startMock({ port: 0, account: true });
  qr = `moodlemobile://${mock.url}?qrlogin=${MOCK_QR_KEY}&userid=${MOCK_USERID}`;
});
beforeEach(() => {
  mock.calls.length = 0;
});
after(async () => {
  await mock.close();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const secrets = () => [MOCK_TOKEN, MOCK_PRIVATE_TOKEN, MOCK_QR_KEY, qr];

function run(args, { input = "" } = {}) {
  return new Promise((done) => {
    const child = execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, MOODLE_KEY: "" } }, (err, stdout, stderr) => {
      for (const bad of secrets()) assert.ok(!(stdout + stderr).includes(bad), `output must not contain a secret (${args.join(" ")})`);
      done({ code: err ? err.code : 0, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
// Real-like run: the QR text is piped, the site comes from it.
const runQr = (args) => run(["--qr", ...args], { input: `${qr}\n` });

async function tempOut() {
  const d = await mkdtemp(join(tmpdir(), "account-test-"));
  dirs.push(d);
  return d;
}

async function readOut(dir) {
  const out = {};
  for (const name of await readdir(dir)) out[name] = await readFile(join(dir, name), "utf8");
  return out;
}

test("writes one file per course with her statuses and grades, plus summary.txt", async () => {
  const out = await tempOut();
  const r = await runQr(["--out", out]);
  assert.equal(r.code, 0, r.stderr);
  const files = await readOut(out);
  assert.deepEqual(Object.keys(files).sort(), ["CS-202.json", "MATH-101.json", "summary.txt"]);

  const math = JSON.parse(files["MATH-101.json"]);
  assert.deepEqual(math.course, { id: 101, shortname: "MATH-101", fullname: "Linear Algebra Basics" });
  const [ps1, ps2] = math.assignments;
  assert.deepEqual(ps1, {
    id: 9001,
    cmid: 5001,
    name: "Problem set 1",
    dueAt: "2026-09-22T00:00:00.000Z",
    cutoffAt: "2026-09-23T00:00:00.000Z",
    status: "submitted",
    graded: true,
    gradingstatus: "graded",
    submittedAt: "2026-09-21T00:00:00.000Z",
    files: [{ name: "ps1.pdf", size: 204800 }],
    requiresSubmitPress: true,
    isGroup: false,
  });
  assert.equal(ps2.status, "draft");
  assert.equal(ps2.submittedAt, null);
  assert.equal(ps2.graded, false);
  assert.equal(ps2.cutoffAt, null, "a cut-off of 0 is no cut-off");

  const g = Object.fromEntries(math.grades.map((x) => [x.id, x]));
  assert.deepEqual(g[41], { id: 41, name: "Problem set 1", itemtype: "mod", itemmodule: "assign", score: 18, max: 20, percent: 90, weight: 0.4, hidden: false, gradedAt: "2026-09-25T01:33:20.000Z", isTotal: false });
  assert.equal(g[42].score, null);
  assert.equal(g[42].percent, null);
  assert.equal(g[43].hidden, true);
  assert.equal(g[43].weight, null, "no weightraw means no weight");
  assert.equal(g[43].percent, 75);
  assert.equal(g[44].isTotal, true, "category total");
  assert.equal(g[45].isTotal, true, "course total");
  assert.equal(g[45].name, "Course total");
  assert.equal(g[45].weight, null, "a null weightraw is not a number");
  assert.equal(math.grades.filter((x) => !x.isTotal).length, 3);
  assert.deepEqual(math.errors, []);

  const cs = JSON.parse(files["CS-202.json"]);
  const byId = Object.fromEntries(cs.assignments.map((a) => [a.id, a]));
  assert.equal(byId[9003].status, "new");
  assert.equal(byId[9003].requiresSubmitPress, false);
  assert.equal(byId[9005].status, "none", "no lastattempt at all");
  assert.equal(byId[9005].dueAt, null);
  assert.equal(cs.grades.find((x) => x.id === 52).score, 9.5, "her grade, not the other user's 10.5");

  assert.match(r.stdout, /MATH-101 +Problem set 1 +\d{4}-\d\d-\d\d \d\d:\d\d +submitted, graded \(1 file, 200\.0 KB\) +18\/20/);
  assert.match(r.stdout, /Midterm exam .* 30\/40 \(hidden\)/);
  assert.match(r.stdout, /CS-202 +Course total .* 9\.5\/20/);
  assert.ok(files["summary.txt"].includes("Lab 2: trees (group)"));
  for (const line of files["summary.txt"].trim().split("\n")) assert.ok(r.stdout.includes(line), "summary.txt is the printed table");
  assert.match(r.stdout.trim().split("\n").pop(), /^Saved 2 courses, 5 assignments, 8 grade items\. Errors: 0\.$/);

  const fns = mock.calls.map((c) => c.fn);
  assert.equal(fns.filter((f) => f === "mod_assign_get_submission_status").length, 5);
  assert.deepEqual(mock.calls.filter((c) => c.fn === "gradereport_user_get_grade_items").map((c) => c.params), [
    { courseid: "101", userid: String(MOCK_USERID) },
    { courseid: "202", userid: String(MOCK_USERID) },
  ]);
  assert.deepEqual(mock.calls.find((c) => c.fn === "mod_assign_get_assignments").params, { "courseids[0]": "101", "courseids[1]": "202" });
});

test("a group assignment is read from teamsubmission", async () => {
  const out = await tempOut();
  const r = await runQr(["--out", out]);
  assert.equal(r.code, 0, r.stderr);
  const lab2 = JSON.parse(await readFile(join(out, "CS-202.json"), "utf8")).assignments.find((a) => a.id === 9004);
  assert.equal(lab2.status, "submitted", "her own submission is 'new'; the group's counts");
  assert.equal(lab2.isGroup, true);
  assert.equal(lab2.submittedAt, iso(1791700000));
  assert.deepEqual(lab2.files, [{ name: "trees.zip", size: 3 * 1024 * 1024 }]);
  assert.match(r.stdout, /Lab 2: trees \(group\) .*submitted, graded \(1 file, 3\.0 MB\) \[group\]/);

  // Same rule straight on the helper, with no assignment-level group flag.
  const row = assignmentRow({ id: 1, name: "x" }, { lastattempt: { submission: { status: "new" }, teamsubmission: { status: "draft", timemodified: 5 } } });
  assert.equal(row.status, "draft");
  assert.equal(row.isGroup, true);
});
const iso = (s) => new Date(s * 1000).toISOString();

test("nothing about other users or feedback text is written or printed", async () => {
  const out = await tempOut();
  const r = await runQr(["--out", out]);
  const all = Object.values(await readOut(out)).join("\n") + r.stdout + r.stderr;
  for (const bad of [...secrets(), "token=", ACCOUNT_FEEDBACK, "Other Student", "Test Student", "10.5", '"score": 19', '"score": 31', "31/40", "fileurl", "pluginfile", "gradefordisplay", "usergrades"]) {
    assert.ok(!all.includes(bad), `must not contain ${bad}`);
  }
  // The helper keeps only the entry for her user id.
  assert.deepEqual(gradeRows({ usergrades: [{ userid: 7, gradeitems: [{ id: 1, itemtype: "mod" }] }] }, 42), []);
});

test("an --out inside the repo is refused before anything is fetched", async () => {
  const inside = join(repoRoot(), "tmp-account-should-not-exist");
  const r = await runQr(["--out", inside]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /inside the git repository/);
  assert.equal(mock.calls.length, 0, "no call reached the mock");
  assert.ok(!existsSync(inside), "folder not created");
  const dot = await run(["--mock", "--out", "."]);
  assert.equal(dot.code, 2);
  assert.match(dot.stderr, /inside the git repository/);
});

test("one failing status call and one failing grade call are recorded; the run continues", async () => {
  const failing = await startMock({ port: 0, account: { failStatus: [9002], failGrades: [202] } });
  try {
    const out = await tempOut();
    const r = await run(["--mock", "--site", failing.url, "--out", out]);
    assert.equal(r.code, 1, "exit 1 when anything failed");
    const math = JSON.parse(await readFile(join(out, "MATH-101.json"), "utf8"));
    const ps2 = math.assignments.find((a) => a.id === 9002);
    assert.equal(ps2.status, null);
    assert.match(ps2.error, /^nopermissions: /);
    assert.equal(ps2.name, "Problem set 2", "the row still says which assignment");
    assert.equal(math.assignments.find((a) => a.id === 9001).status, "submitted", "the others still read");
    assert.equal(math.grades.length, 5);

    const cs = JSON.parse(await readFile(join(out, "CS-202.json"), "utf8"));
    assert.equal(cs.assignments.length, 3, "statuses after the failure were still read");
    assert.deepEqual(cs.grades, []);
    assert.equal(cs.errors.length, 1);
    assert.equal(cs.errors[0].call, "gradereport_user_get_grade_items");

    assert.match(r.stdout, /Problem set 2 .*error \(nopermissions/);
    assert.match(r.stdout.trim().split("\n").pop(), /^Saved 2 courses, 5 assignments, 5 grade items\. Errors: 2\.$/);
  } finally {
    await failing.close();
  }
});

test("the script is read-only", async () => {
  const src = await readFile(SCRIPT, "utf8");
  for (const s of ["save_submission", "submit_for_grading", "upload.php", "upload("]) assert.ok(!src.includes(s), `script is read-only (${s})`);
});

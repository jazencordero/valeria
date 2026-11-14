import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, MOCK_TOKEN, MOCK_PRIVATE_TOKEN } from "./mock.mjs";
import { CHECK_FUNCTIONS } from "./probe.mjs";

const PROBE = fileURLToPath(new URL("./probe.mjs", import.meta.url));
// The mock's personal values (see SITE_INFO in mock.mjs). None may reach a fixture.
const MOCK_PERSONAL = ["student42", "Test Student", MOCK_TOKEN, MOCK_PRIVATE_TOKEN];

const CALLS = [
  "core_webservice_get_site_info",
  "core_enrol_get_users_courses",
  "mod_assign_get_assignments",
  "core_course_get_contents",
  "(pluginfile download)",
  "gradereport_user_get_grade_items",
  "core_calendar_get_action_events_by_timesort",
  "mod_assign_get_submission_status",
];

let mock;
const dirs = [];

before(async () => {
  mock = await startMock({ port: 0 });
});

after(async () => {
  await mock.close();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function run(args, { env = {}, input } = {}) {
  return new Promise((done) => {
    const child = execFile(process.execPath, [PROBE, ...args], { env: { ...process.env, MOODLE_KEY: "", ...env } }, (err, stdout, stderr) =>
      done({ code: err ? err.code : 0, stdout, stderr }),
    );
    child.stdin.end(input ?? "");
  });
}

async function tempOut() {
  const d = await mkdtemp(join(tmpdir(), "probe-test-"));
  dirs.push(d);
  return d;
}

function callRows(report) {
  const section = report.split("## Calls")[1].split("\n## ")[0];
  return section.split("\n").filter((l) => /^\| \d+ \|/.test(l));
}

async function checkOutputs(out) {
  const report = await readFile(join(out, "probe-report.md"), "utf8");
  const rows = callRows(report);
  assert.equal(rows.length, CALLS.length, "one row per call");
  CALLS.forEach((fn, i) => assert.ok(rows[i].includes(`\`${fn}\``), `row ${i + 1} is ${fn}`));

  for (const fn of CHECK_FUNCTIONS) assert.ok(report.includes(`\`${fn}\``), `report checks ${fn}`);

  const files = await readdir(join(out, "fixtures"));
  assert.ok(files.length >= 4, "fixtures written for the calls that worked");
  for (const f of files) {
    const text = await readFile(join(out, "fixtures", f), "utf8");
    for (const bad of MOCK_PERSONAL) assert.ok(!text.includes(bad), `${f} must not contain a mock personal value`);
  }
  for (const bad of MOCK_PERSONAL) assert.ok(!report.includes(bad), "report must not contain a mock personal value");
  return { report, rows, files };
}

test("--mock writes one report row per call and scrubbed fixtures", async () => {
  const out = await tempOut();
  const r = await run(["--mock", "--site", mock.url, "--out", out]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes(MOCK_TOKEN) && !r.stderr.includes(MOCK_TOKEN), "token never printed");

  const { rows, files } = await checkOutputs(out);
  assert.ok(rows[0].includes("worked"), "site info worked");
  assert.ok(rows[1].includes("worked"), "courses worked");
  // Calls the mock does not know come back as Moodle errors and are recorded as such.
  assert.ok(rows[5].includes("invalidrecord"), "grade items recorded as an error row");
  assert.ok(files.includes("core_webservice_get_site_info.json"));
  assert.ok(!files.some((f) => f.includes("grade_items")), "no fixture for a failed call");
});

test("--mock starts its own mock when no site is given", async () => {
  const out = await tempOut();
  const r = await run(["--mock", "--out", out]);
  assert.equal(r.code, 0, r.stderr);
  await checkOutputs(out);
});

test("key from MOODLE_KEY or stdin, never echoed", async () => {
  for (const how of ["env", "stdin"]) {
    const out = await tempOut();
    const opts = how === "env" ? { env: { MOODLE_KEY: MOCK_TOKEN } } : { input: `${MOCK_TOKEN}\n` };
    const r = await run(["--site", mock.url, "--out", out], opts);
    assert.equal(r.code, 0, `${how}: ${r.stderr}`);
    assert.ok(!r.stdout.includes(MOCK_TOKEN) && !r.stderr.includes(MOCK_TOKEN), `${how}: token never printed`);
    await checkOutputs(out);
  }
});

test("a wrong key is recorded as invalidtoken and exits non-zero", async () => {
  const out = await tempOut();
  const r = await run(["--site", mock.url, "--out", out], { env: { MOODLE_KEY: "wrongkey" } });
  assert.equal(r.code, 1);
  const report = await readFile(join(out, "probe-report.md"), "utf8");
  assert.ok(callRows(report)[0].includes("invalidtoken"));
  assert.ok(!report.includes("wrongkey"));
});

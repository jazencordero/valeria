import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { startMock, MOCK_TOKEN, MOCK_PRIVATE_TOKEN, MOCK_QR_KEY, MOCK_USERID } from "./mock.mjs";
import { CHECK_FUNCTIONS, cleanRedirect, parseArgs, signatureMatches } from "./probe.mjs";
import { launchUrl } from "./lib/keys.mjs";

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

// ---- M0-05: --qr, --redirect, --launch-url -------------------------------------------

const SECRETS = [MOCK_TOKEN, MOCK_PRIVATE_TOKEN, MOCK_QR_KEY];
function neverPrinted(r, label) {
  for (const bad of SECRETS) assert.ok(!r.stdout.includes(bad) && !r.stderr.includes(bad), `${label}: ${bad} never printed`);
}

async function mockRedirect(passport) {
  const res = await fetch(launchUrl(mock.url, passport), { redirect: "manual" });
  return res.headers.get("location");
}

test("parseArgs: the key flags are the probe's only, one at a time", () => {
  assert.throws(() => parseArgs(["--qr"]), /Unknown option/, "handin-test does not take --qr");
  assert.equal(parseArgs(["--qr"], { keyFlags: true }).mode, "qr");
  assert.equal(parseArgs(["--launch-url", "--passport", "p"], { keyFlags: true }).passport, "p");
  assert.equal(parseArgs(["--launch-url"], { keyFlags: true }).scheme, "moodlemobile");
  assert.throws(() => parseArgs(["--qr", "--redirect"], { keyFlags: true }), /only one/);
  assert.throws(() => parseArgs(["--qr", "--passport", "p"], { keyFlags: true }), /--passport goes with/);
  assert.throws(() => parseArgs(["--redirect", "--passport"], { keyFlags: true }), /need a value/);
});

test("signatureMatches checks md5(site + passport), http or https, and the mock's scheme only with mock", () => {
  const sig = createHash("md5").update("https://mycourses.example.org" + "p1").digest("hex");
  assert.ok(signatureMatches(sig, "https://mycourses.example.org/", "p1"));
  assert.ok(signatureMatches(sig, "http://mycourses.example.org", "p1"));
  assert.ok(!signatureMatches(sig, "https://mycourses.example.org", "p2"));
  assert.ok(!signatureMatches("mocksigp1", "https://x.example.org", "p1"));
  assert.ok(signatureMatches("mocksigp1", "https://x.example.org", "p1", { mock: true }));
});

test("cleanRedirect finds the token part in a pasted console line", () => {
  assert.equal(cleanRedirect("Failed to launch 'moodlemobile://token=QUJD==' because..."), "token=QUJD==");
  assert.throws(() => cleanRedirect("https://example.org/"), /not a moodlemobile/);
});

test("--launch-url prints the address and passport, exits 0", async () => {
  const r = await run(["--launch-url", "--site", mock.url, "--passport", "pp1"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(launchUrl(mock.url, "pp1")), "prints the launch address");
  assert.ok(r.stdout.includes("Passport: pp1"));
  assert.ok(r.stdout.includes("--redirect --passport pp1"), "says the next command");
  const mine = await run(["--launch-url", "--mock", "--scheme", "myapp"]);
  assert.equal(mine.code, 0, mine.stderr);
  assert.match(mine.stdout, /urlscheme=myapp/);
  assert.match(mine.stdout, /Passport: [0-9a-f]{16}\n/, "a random passport when none is given");
  assert.match(mine.stdout, /answers with a token redirect/, "the mock link was checked");
  neverPrinted(mine, "launch-url");
});

test("--qr swaps the pasted QR text for a key and runs the probe; site comes from the QR", async () => {
  const out = await tempOut();
  const qr = `moodlemobile://${mock.url}?qrlogin=${MOCK_QR_KEY}&userid=${MOCK_USERID}`;
  const r = await run(["--qr", "--out", out], { input: `${qr}\n` });
  assert.equal(r.code, 0, r.stderr);
  neverPrinted(r, "qr");
  const { rows } = await checkOutputs(out);
  assert.ok(rows[0].includes("worked"));
  const report = await readFile(join(out, "probe-report.md"), "utf8");
  assert.ok(!report.includes(MOCK_QR_KEY), "QR key not in the report");
});

test("--qr --mock works with nothing pasted, and a used or wrong QR key exits 2 without printing it", async () => {
  const out = await tempOut();
  const r = await run(["--qr", "--mock", "--out", out]);
  assert.equal(r.code, 0, r.stderr);
  await checkOutputs(out);
  const bad = await run(["--qr", "--out", out], { input: `moodlemobile://${mock.url}?qrlogin=wrongqrkey9&userid=${MOCK_USERID}\n` });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /invalidkey.*new QR code/);
  assert.ok(!bad.stderr.includes("wrongqrkey9"), "the key is not echoed");
  const junk = await run(["--qr", "--out", out], { input: "hello\n" });
  assert.equal(junk.code, 2);
});

test("--redirect decodes the pasted address, checks the signature with --passport, runs the probe", async () => {
  const out = await tempOut();
  const redirect = await mockRedirect("pp2");
  const r = await run(["--redirect", "--mock", "--site", mock.url, "--passport", "pp2", "--out", out], {
    input: `Failed to launch '${redirect}' because the scheme does not have a registered handler.\n`,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Signature matches/);
  neverPrinted(r, "redirect");
  await checkOutputs(out);

  const wrong = await run(["--redirect", "--mock", "--site", mock.url, "--passport", "other", "--out", out], { input: `${redirect}\n` });
  assert.equal(wrong.code, 0, "a mismatch warns but the read-only probe still runs");
  assert.match(wrong.stderr, /does not match/);

  const none = await run(["--redirect", "--site", mock.url, "--out", out], { input: `${redirect}\n` });
  assert.equal(none.code, 0, none.stderr);
  assert.match(none.stderr, /Signature not checked/);
  neverPrinted(none, "redirect without passport");
});

test("--redirect --mock works with nothing pasted; a bad paste exits 2", async () => {
  const out = await tempOut();
  const r = await run(["--redirect", "--mock", "--out", out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Signature matches/);
  await checkOutputs(out);
  const bad = await run(["--redirect", "--site", mock.url, "--out", out], { input: "https://example.org/\n" });
  assert.equal(bad.code, 2);
});

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, MOCK_TOKEN, MOCK_PRIVATE_TOKEN, MOCK_QR_KEY, MOCK_USERID, LECTURE_FILES } from "./mock.mjs";
import { collectPdfs, downloadTo, fileNameFor, matchCourses, repoRoot, safePart, tokenUrl } from "./fetch-lectures.mjs";

const SCRIPT = fileURLToPath(new URL("./fetch-lectures.mjs", import.meta.url));

let mock;
const dirs = [];
let qr;

before(async () => {
  mock = await startMock({ port: 0, lectures: true });
  qr = `moodlemobile://${mock.url}?qrlogin=${MOCK_QR_KEY}&userid=${MOCK_USERID}`;
});
beforeEach(() => {
  mock.calls.length = 0;
});
after(async () => {
  await mock.close();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function run(args, { input = "", env = {} } = {}) {
  return new Promise((done) => {
    const child = execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, MOODLE_KEY: "", ...env } }, (err, stdout, stderr) => {
      const all = stdout + stderr;
      for (const bad of [MOCK_TOKEN, MOCK_PRIVATE_TOKEN, MOCK_QR_KEY, qr]) {
        assert.ok(!all.includes(bad), `output must not contain a secret (${args.join(" ")})`);
      }
      done({ code: err ? err.code : 0, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

// Real-like run: the QR text is piped, the site comes from it.
const runQr = (args) => run(["--qr", ...args], { input: `${qr}\n` });

async function tempOut() {
  const d = await mkdtemp(join(tmpdir(), "lectures-test-"));
  dirs.push(d);
  return d;
}

const downloads = () => mock.calls.filter((c) => c.fn === "download");

test("no --course lists the courses", async () => {
  const r = await runQr([]);
  assert.equal(r.code, 0, r.stderr);
  for (const s of ["MATH-101", "CS-202", "CS-C3120  Human-Computer Interaction", "CS-C3100  Computer Graphics"]) assert.ok(r.stdout.includes(s), s);
  assert.equal(downloads().length, 0);
});

test("--mock alone starts its own mock and lists courses", async () => {
  const r = await run(["--mock", "--qr"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("CS-C3120"));
});

test("course match: prefix, any case; none and several exit non-zero", async () => {
  const out = await tempOut();
  const ok = await runQr(["--course", "cs-c312", "--out", out, "--max", "1"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(ok.stdout.includes("Course: CS-C3120"));

  const none = await runQr(["--course", "PHYS", "--out", out]);
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /No course short name starts with "PHYS"/);
  assert.ok(none.stderr.includes("MATH-101"), "lists the courses");

  const many = await runQr(["--course", "CS-C31", "--out", out]);
  assert.notEqual(many.code, 0);
  assert.match(many.stderr, /matches 2 courses/);
  assert.ok(many.stderr.includes("CS-C3120") && many.stderr.includes("CS-C3100"));

  assert.deepEqual(matchCourses([{ shortname: "AB" }, { shortname: "AB-2" }], "ab").map((c) => c.shortname), ["AB"], "one exact match wins");
});

test("an --out inside the repo is refused before anything is fetched", async () => {
  const inside = join(repoRoot(), "tmp-lectures-should-not-exist");
  const r = await runQr(["--course", "CS-C3120", "--out", inside]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /inside the git repository/);
  assert.equal(mock.calls.length, 0, "no call reached the mock");
  assert.ok(!existsSync(inside), "folder not created");
  const viaTilde = await run(["--qr", "--course", "CS-C3120", "--out", "."], { input: `${qr}\n` });
  assert.notEqual(viaTilde.code, 0);
});

test("saves the visible PDFs with the right names, skips the 40 MB one", async () => {
  const out = await tempOut();
  const r = await runQr(["--course", "CS-C3120", "--out", out]);
  assert.equal(r.code, 0, r.stderr);
  const files = (await readdir(out)).sort();
  assert.deepEqual(files, [
    "00-Course overview.pdf",
    "01-Exercise sheets-ex1.pdf",
    "01-Exercise sheets-ex2.pdf",
    "01-Lecture 1 What is HCI.pdf",
    "02-Lecture 3.pdf",
  ]);
  const bytes = await readFile(join(out, "01-Lecture 1 What is HCI.pdf"));
  assert.ok(bytes.equals(LECTURE_FILES["/webservice/pluginfile.php/32/mod_resource/content/1/lecture1.pdf"]));
  assert.match(r.stdout, /02 {2}02-Lecture 2 full recording slides\.pdf {2}40\.0 MB {2}skipped \(over 30\.0 MB\)/);
  assert.ok(!downloads().some((c) => c.params.path.includes("lecture2")), "the big file was never requested");
  assert.ok(!downloads().some((c) => /draft|notes/.test(c.params.path)), "hidden module and non-PDF not fetched");
  assert.match(r.stdout, /Saved 5, skipped 1\./);

  // Second run: same sizes are skipped; a different file under the name gets -2.
  await writeFile(join(out, "02-Lecture 3.pdf"), "something else");
  const again = await runQr(["--course", "CS-C3120", "--out", out]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /00-Course overview\.pdf .*skipped \(already there, same size\)/);
  assert.match(again.stdout, /02-Lecture 3-2\.pdf .*saved/);
  assert.equal((await readFile(join(out, "02-Lecture 3.pdf"), "utf8")), "something else", "not overwritten");
});

test("--max stops early and says how many more; --match filters", async () => {
  const out = await tempOut();
  const r = await runQr(["--course", "CS-C3120", "--out", out, "--max", "2"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await readdir(out)).length, 2);
  assert.match(r.stdout, /Saved 2, skipped 0\. 4 more matched; raise --max/);

  const out2 = await tempOut();
  const m = await runQr(["--course", "CS-C3120", "--out", join(out2, "new", "sub"), "--match", "EXERCISE"]);
  assert.equal(m.code, 0, m.stderr);
  assert.deepEqual((await readdir(join(out2, "new", "sub"))).sort(), ["01-Exercise sheets-ex1.pdf", "01-Exercise sheets-ex2.pdf"]);

  const byFile = await runQr(["--course", "CS-C3120", "--out", out2, "--match", "lecture3"]);
  assert.match(byFile.stdout, /02-Lecture 3\.pdf .*saved/);
  assert.match(byFile.stdout, /Saved 1, skipped 0\./);
});

test("the download stops once the stream passes the cap", async () => {
  const out = await tempOut();
  const url = tokenUrl(mock.url, "/webservice/pluginfile.php/32/mod_resource/content/1/lecture1.pdf", MOCK_TOKEN);
  await assert.rejects(downloadTo(url, join(out, "x.pdf"), { limit: 10 }), (err) => /over/.test(err.message) && !err.message.includes(MOCK_TOKEN));
  assert.deepEqual(await readdir(out), [], "no partial file left");
  const bad = tokenUrl(mock.url, "/webservice/pluginfile.php/32/mod_resource/content/1/lecture1.pdf", "wrong");
  await assert.rejects(downloadTo(bad, join(out, "y.pdf")), /invalidtoken/);
});

test("helpers: names, URLs, collection", async () => {
  assert.equal(safePart("a/b\\c:\u0007  d"), "a b c d");
  assert.equal(fileNameFor(3, "Slides", "w1/intro.PDF"), "03-Slides-w1 intro.pdf");
  assert.ok(fileNameFor(1, "x".repeat(500)).length <= 124);
  const u = tokenUrl("https://m.example.org/", "https://m.example.org/pluginfile.php/1/a.pdf", "T");
  assert.equal(u.pathname, "/webservice/pluginfile.php/1/a.pdf");
  assert.equal(u.searchParams.get("token"), "T");
  assert.equal(tokenUrl("https://m.example.org", "https://evil.example.com/a.pdf", "T"), null, "no token to another host");
  const got = collectPdfs([{ section: 4, modules: [{ modname: "page", name: "p", contents: [{ type: "file", filename: "a.pdf", fileurl: "/x" }] }] }]);
  assert.deepEqual(got, [], "only resource and folder modules");
  assert.ok((await stat(SCRIPT)).isFile());
  const src = await readFile(SCRIPT, "utf8");
  for (const s of ["save_submission", "submit_for_grading", "upload.php"]) assert.ok(!src.includes(s), `script is read-only (${s})`);
});

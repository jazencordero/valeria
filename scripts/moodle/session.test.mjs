import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, MOCK_TOKEN, MOCK_PRIVATE_TOKEN, MOCK_QR_KEY, MOCK_USERID } from "./mock.mjs";
import { decodeQrImage, LOGIN_PROMPT, parseArgs } from "./session.mjs";
import * as keychain from "./lib/keychain.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const SESSION = here("./session.mjs");
const FETCH = here("./fetch-lectures.mjs");
const PROBE = here("./probe.mjs");
const QR_PNG = here("./fixtures/mock-qr.png");
const FIXTURE_QR = `moodlemobile://https://mock.invalid?qrlogin=${MOCK_QR_KEY}&userid=${MOCK_USERID}`;

// A fake `security`: keeps passwords in a JSON file and logs every argv it was given.
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
const file = process.env.READY_FAKE_KEYCHAIN_FILE;
const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { items: {}, argv: [] };
const args = process.argv.slice(2);
db.argv.push(args);
const flag = (list, f) => list[list.indexOf(f) + 1];
const save = () => fs.writeFileSync(file, JSON.stringify(db));
const id = (list) => flag(list, "-s") + "|" + flag(list, "-a");
if (args[0] === "-i") {
  const input = fs.readFileSync(0, "utf8");
  for (const line of input.split("\\n").filter(Boolean)) {
    const words = [...line.matchAll(/"((?:\\\\.|[^"\\\\])*)"|(\\S+)/g)].map((m) => m[1] !== undefined ? m[1].replace(/\\\\(.)/g, "$1") : m[2]);
    if (words[0] === "add-generic-password") db.items[id(words)] = flag(words, "-w");
  }
  save();
  process.exit(0);
}
if (args[0] === "find-generic-password") {
  save();
  const v = db.items[id(args)];
  if (v === undefined) process.exit(44);
  process.stdout.write(v + "\\n");
  process.exit(0);
}
if (args[0] === "delete-generic-password") {
  const had = id(args) in db.items;
  delete db.items[id(args)];
  save();
  process.exit(had ? 0 : 44);
}
process.exit(1);
`;

let mock;
let work;
let env;
let fakeFile;

before(async () => {
  mock = await startMock({ port: 0, lectures: true });
  work = await mkdtemp(join(tmpdir(), "session-test-"));
  const cmd = join(work, "fake-security");
  await writeFile(cmd, FAKE);
  await chmod(cmd, 0o755);
  fakeFile = join(work, "keychain.json");
  env = { ...process.env, MOODLE_KEY: "", READY_KEYCHAIN_CMD: cmd, READY_FAKE_KEYCHAIN_FILE: fakeFile };
  // In-process keychain calls use the fake too.
  process.env.READY_KEYCHAIN_CMD = cmd;
  process.env.READY_FAKE_KEYCHAIN_FILE = fakeFile;
});
after(async () => {
  await mock.close();
  await rm(work, { recursive: true, force: true });
});

const SECRETS = () => [MOCK_TOKEN, MOCK_PRIVATE_TOKEN, MOCK_QR_KEY, FIXTURE_QR, `moodlemobile://${mock.url}?qrlogin=${MOCK_QR_KEY}&userid=${MOCK_USERID}`];

function run(script, args, { input = "" } = {}) {
  return new Promise((done) => {
    const child = execFile(process.execPath, [script, ...args], { env }, (err, stdout, stderr) => {
      const all = stdout + stderr;
      for (const bad of SECRETS()) assert.ok(!all.includes(bad), `output must not contain a secret (${args.join(" ")})`);
      done({ code: err ? err.code : 0, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
const session = (args, o) => run(SESSION, [...args, "--mock", "--site", mock.url], o);
const db = async () => JSON.parse(await readFile(fakeFile, "utf8"));
const stored = async () => (await db()).items[`${keychain.SERVICE}|${keychain.normaliseSite(mock.url)}`];

test("the committed test image decodes to the mock's QR text", async () => {
  assert.equal(await decodeQrImage(QR_PNG), FIXTURE_QR);
});

test("login --file stores the key and prints the signed-in line", async () => {
  const r = await session(["login", "--file", QR_PNG]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), `Signed in as user ${MOCK_USERID} on ${keychain.normaliseSite(mock.url)}. Key kept in your Mac's Keychain until you run logout.`);
  assert.equal(await stored(), MOCK_TOKEN);
  for (const argv of (await db()).argv) assert.ok(!argv.join(" ").includes(MOCK_TOKEN), "the key never goes on a command line");
});

test("an image with no QR code falls back to the hidden QR-text prompt", async () => {
  await run(SESSION, ["logout", "--mock", "--site", mock.url]);
  const notQr = join(work, "blank.png");
  // A real 1x1 PNG: an image, but no QR code in it.
  await writeFile(notQr, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64"));
  const r = await session(["login", "--file", notQr], { input: `${FIXTURE_QR}\n` });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /No QR code found in that image/);
  assert.match(r.stderr, /QR text \(hidden\)/);
  assert.match(r.stdout, /Signed in as user 42/);
  assert.equal(await stored(), MOCK_TOKEN);

  const junk = await session(["login", "--file", join(work, "fake-security")], { input: `${FIXTURE_QR}\n` });
  assert.equal(junk.code, 0, junk.stderr);
  assert.match(junk.stderr, /Could not read the QR code/);
});

// A fake osascript: "copies" the test image into the file the script opened, or has none.
async function fakeClipboard(withImage) {
  const cmd = join(work, withImage ? "fake-osascript-img" : "fake-osascript-none");
  const body = withImage
    ? `#!/usr/bin/env node
const fs = require("fs");
const m = /POSIX file "([^"]+)"/.exec(process.argv.slice(2).join(" "));
if ((fs.statSync(m[1]).mode & 0o777) !== 0o600) process.exit(3);
fs.writeFileSync(m[1], fs.readFileSync(${JSON.stringify(QR_PNG)}));
`
    : "#!/bin/sh\necho \"Can't make some data into the expected type.\" >&2\nexit 1\n";
  await writeFile(cmd, body);
  await chmod(cmd, 0o755);
  return cmd;
}

test("login from the clipboard: exact prompt, 0600 temp file, removed afterwards", async () => {
  await run(SESSION, ["logout", "--mock", "--site", mock.url]);
  env.READY_OSASCRIPT_CMD = await fakeClipboard(true);
  const before = (await readdir(tmpdir())).filter((n) => n.startsWith("ready-clip-")).length;
  try {
    const r = await session(["login"], { input: "\n" });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stderr.startsWith(LOGIN_PROMPT), r.stderr);
    assert.match(r.stdout, /Signed in as user 42/);
    assert.equal(await stored(), MOCK_TOKEN);
  } finally {
    delete env.READY_OSASCRIPT_CMD;
  }
  const afterCount = (await readdir(tmpdir())).filter((n) => n.startsWith("ready-clip-")).length;
  assert.ok(afterCount <= before, "the clipboard temp folder was deleted");
  assert.equal(
    LOGIN_PROMPT,
    "Show the QR code on your MyCourses profile, take a screenshot of just the code to the clipboard (Cmd+Ctrl+Shift+4), then press Enter",
  );
});

test("login with no image on the clipboard falls back to the QR-text prompt", async () => {
  await run(SESSION, ["logout", "--mock", "--site", mock.url]);
  env.READY_OSASCRIPT_CMD = await fakeClipboard(false);
  try {
    const r = await session(["login"], { input: `\n${FIXTURE_QR}\n` });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /no image on the clipboard/);
    assert.match(r.stdout, /Signed in as user 42/);
  } finally {
    delete env.READY_OSASCRIPT_CMD;
  }
});

test("status with a key, then logout, then status without a key", async () => {
  await session(["login", "--file", QR_PNG]);
  const yes = await session(["status"]);
  assert.equal(yes.code, 0, yes.stderr);
  assert.match(yes.stdout, /Key stored for .*Moodle accepts it: user 42 on Mock University\./);

  const out = await session(["logout"]);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /Removed the key/);
  assert.equal(await stored(), undefined);
  const again = await session(["logout"]);
  assert.match(again.stdout, /No key was stored/);

  const no = await session(["status"]);
  assert.equal(no.code, 1);
  assert.match(no.stdout, /No key stored for/);
});

test("status says when Moodle no longer accepts the stored key", async () => {
  await keychain.set(mock.url, "expiredkey0000", { cmd: env.READY_KEYCHAIN_CMD });
  const r = await session(["status"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /did not accept it \(invalidtoken\)/);
  assert.ok(!r.stdout.includes("expiredkey0000"));
  await session(["logout"]);
});

test("fetch-lectures with --course and no --qr uses the stored key", async () => {
  await session(["login", "--file", QR_PNG]);
  const out = await mkdtemp(join(tmpdir(), "session-fetch-"));
  try {
    const r = await run(FETCH, ["--site", mock.url, "--course", "CS-C3120", "--out", out, "--max", "2"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Using the key in your Mac's Keychain/);
    assert.equal((await readdir(out)).length, 2);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("probe uses the stored key, and a piped key still wins", async () => {
  await session(["login", "--file", QR_PNG]);
  const out = await mkdtemp(join(tmpdir(), "session-probe-"));
  try {
    const r = await run(PROBE, ["--site", mock.url, "--out", out]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Using the key in your Mac's Keychain/);
    assert.match(r.stdout, /calls worked/);
    const report = await readFile(join(out, "probe-report.md"), "utf8");
    assert.ok(!report.includes(MOCK_TOKEN));

    const piped = await run(PROBE, ["--site", mock.url, "--out", out], { input: "wrongkey\n" });
    assert.equal(piped.code, 1, "the piped (wrong) key was used, not the Keychain one");
  } finally {
    await rm(out, { recursive: true, force: true });
    await session(["logout"]);
  }
});

test("args and site names", () => {
  assert.throws(() => parseArgs([]), /login, status or logout/);
  assert.throws(() => parseArgs(["status", "--file", "x"]), /--file goes with login/);
  assert.equal(keychain.normaliseSite("https://MyCourses.aalto.fi/"), "https://mycourses.aalto.fi");
  assert.equal(keychain.normaliseSite("mycourses.aalto.fi"), "https://mycourses.aalto.fi");
});

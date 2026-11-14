import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchUrl, decodeLaunchRedirect, parseQr, exchangeQr } from "./keys.mjs";
import { MoodleError } from "./ws.mjs";
import { startMock, MOCK_TOKEN, MOCK_PRIVATE_TOKEN, MOCK_QR_KEY, MOCK_USERID } from "../mock.mjs";

let mock;
before(async () => {
  mock = await startMock();
});
after(async () => {
  await mock.close();
});

const b64 = (s) => Buffer.from(s).toString("base64");

test("launchUrl builds the launch.php link", () => {
  const u = new URL(launchUrl("https://moodle.example.edu/", "12345", "readyapp"));
  assert.equal(u.origin + u.pathname, "https://moodle.example.edu/admin/tool/mobile/launch.php");
  assert.equal(u.searchParams.get("service"), "moodle_mobile_app");
  assert.equal(u.searchParams.get("passport"), "12345");
  assert.equal(u.searchParams.get("urlscheme"), "readyapp");
});

test("decodeLaunchRedirect: with private token", () => {
  const got = decodeLaunchRedirect(`moodlemobile://token=${b64("sigabc:::tok123:::priv456")}`);
  assert.deepEqual(got, { signature: "sigabc", token: "tok123", privatetoken: "priv456" });
});

test("decodeLaunchRedirect: without private token", () => {
  const got = decodeLaunchRedirect(`readyapp://token=${b64("sigabc:::tok123")}`);
  assert.deepEqual(got, { signature: "sigabc", token: "tok123", privatetoken: null });
});

test("decodeLaunchRedirect: URL-encoded base64 still decodes", () => {
  const got = decodeLaunchRedirect(`moodlemobile://token=${encodeURIComponent(b64("s:::t>?"))}`);
  assert.equal(got.token, "t>?");
});

test("decodeLaunchRedirect: rejects junk", () => {
  assert.throws(() => decodeLaunchRedirect("moodlemobile://nothing"));
  assert.throws(() => decodeLaunchRedirect(`moodlemobile://token=${b64("no-separator")}`));
});

test("launch flow against the mock: follow launch.php, decode the redirect", async () => {
  const res = await fetch(launchUrl(mock.url, "777", "readyapp"), { redirect: "manual" });
  const location = res.headers.get("location");
  assert.ok(location.startsWith("readyapp://token="));
  const got = decodeLaunchRedirect(location);
  assert.equal(got.token, MOCK_TOKEN);
  assert.equal(got.privatetoken, MOCK_PRIVATE_TOKEN);
  assert.equal(got.signature, "mocksig777");
});

test("parseQr reads site, key and userid", () => {
  assert.deepEqual(parseQr("moodlemobile://https://moodle.example.edu?qrlogin=abc123&userid=42"), {
    site: "https://moodle.example.edu",
    key: "abc123",
    userid: 42,
  });
});

test("parseQr keeps a site sub-path", () => {
  assert.deepEqual(parseQr("moodlemobile://https://example.edu/moodle/?qrlogin=k_1&userid=7"), {
    site: "https://example.edu/moodle",
    key: "k_1",
    userid: 7,
  });
});

test("parseQr rejects text with no key or userid", () => {
  assert.throws(() => parseQr("moodlemobile://https://moodle.example.edu"));
  assert.throws(() => parseQr("moodlemobile://https://moodle.example.edu?qrlogin=abc"));
  assert.throws(() => parseQr("hello"));
});

test("exchangeQr swaps the QR key for a token via the mock", async () => {
  const { site, key, userid } = parseQr(`moodlemobile://${mock.url}?qrlogin=${MOCK_QR_KEY}&userid=${MOCK_USERID}`);
  const got = await exchangeQr(site, key, userid);
  assert.deepEqual(got, { token: MOCK_TOKEN, privatetoken: MOCK_PRIVATE_TOKEN });
});

test("exchangeQr maps a bad key to MoodleError", async () => {
  await assert.rejects(exchangeQr(mock.url, "wrongkey", MOCK_USERID), (err) => {
    assert.ok(err instanceof MoodleError);
    assert.equal(err.errorcode, "invalidkey");
    return true;
  });
});

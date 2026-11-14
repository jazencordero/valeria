import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { call, upload, flattenParams, MoodleError } from "./ws.mjs";
import { startMock, MOCK_TOKEN } from "../mock.mjs";

let mock;
before(async () => {
  mock = await startMock();
});
after(async () => {
  await mock.close();
});

test("flattenParams: scalars, arrays, nested objects, booleans", () => {
  const flat = flattenParams({
    courseids: [3, 4],
    options: [{ name: "excludemodules", value: true }],
    nested: { a: { b: 1 } },
    off: false,
    skip: undefined,
    alsoskip: null,
  });
  assert.deepEqual(flat, [
    ["courseids[0]", "3"],
    ["courseids[1]", "4"],
    ["options[0][name]", "excludemodules"],
    ["options[0][value]", "1"],
    ["nested[a][b]", "1"],
    ["off", "0"],
  ]);
});

test("flattenParams: empty input gives no pairs", () => {
  assert.deepEqual(flattenParams({}), []);
  assert.deepEqual(flattenParams(undefined), []);
});

test("call sends flattened params the Moodle way", async () => {
  const got = await call(mock.url, MOCK_TOKEN, "mock_echo_params", { a: [{ b: 1 }], c: "x" });
  assert.deepEqual(got, { "a[0][b]": "1", c: "x" });
});

test("call returns sample data from the mock", async () => {
  const courses = await call(mock.url, MOCK_TOKEN, "core_enrol_get_users_courses", { userid: 42 });
  assert.equal(courses.length, 2);
  const assigns = await call(`${mock.url}/`, MOCK_TOKEN, "mod_assign_get_assignments", { courseids: [101, 202] });
  assert.equal(assigns.courses.flatMap((c) => c.assignments).length, 3);
  const contents = await call(mock.url, MOCK_TOKEN, "core_course_get_contents", { courseid: 101 });
  assert.equal(contents[0].modules[0].contents[0].filename, "lecture1.pdf");
});

test("call maps an exception answer to MoodleError without leaking the token", async () => {
  const secret = "notthetoken1234567890";
  await assert.rejects(call(mock.url, secret, "core_webservice_get_site_info"), (err) => {
    assert.ok(err instanceof MoodleError);
    assert.equal(err.errorcode, "invalidtoken");
    assert.equal(err.exception, "moodle_exception");
    assert.ok(!err.message.includes(secret));
    assert.ok(!(err.stack || "").includes(secret));
    return true;
  });
});

test("call maps an unknown function to MoodleError", async () => {
  await assert.rejects(call(mock.url, MOCK_TOKEN, "no_such_function"), (err) => {
    assert.ok(err instanceof MoodleError);
    assert.equal(err.errorcode, "invalidrecord");
    assert.equal(err.exception, "dml_missing_record_exception");
    return true;
  });
});

test("call maps an HTTP 404 to MoodleError", async () => {
  await assert.rejects(call(`${mock.url}/nowhere`, MOCK_TOKEN, "core_webservice_get_site_info"), (err) => {
    assert.ok(err instanceof MoodleError);
    assert.equal(err.status, 404);
    return true;
  });
});

test("upload returns the draft itemid", async () => {
  const itemid = await upload(mock.url, MOCK_TOKEN, new TextEncoder().encode("hello"), "notes.txt");
  assert.equal(itemid, 777001);
});

test("upload maps an error answer to MoodleError", async () => {
  await assert.rejects(upload(mock.url, "wrong", new Uint8Array([1, 2]), "a.bin"), (err) => {
    assert.ok(err instanceof MoodleError);
    assert.equal(err.errorcode, "invalidtoken");
    return true;
  });
});

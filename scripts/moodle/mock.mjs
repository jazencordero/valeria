// Local fake Moodle for tests and dry runs. All data is invented.
// Use from code: const mock = await startMock(); ... await mock.close();
// Run by hand:   node scripts/moodle/mock.mjs   (PORT env, default 8787)

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// Fake credentials. Not real secrets; they only work against this mock.
export const MOCK_TOKEN = "mocktoken0000000000000000000000a";
export const MOCK_PRIVATE_TOKEN = "mockprivate00000000000000000000b";
export const MOCK_QR_KEY = "mockqrkey123";
export const MOCK_USERID = 42;

const SITE_INFO = {
  sitename: "Mock University",
  username: "student42",
  firstname: "Test",
  lastname: "Student",
  fullname: "Test Student",
  lang: "en",
  userid: MOCK_USERID,
  release: "4.5 (Build: 20241007)",
  version: "2024100700",
};

const COURSES = [
  { id: 101, shortname: "MATH-101", fullname: "Linear Algebra Basics", visible: 1, startdate: 1788220800, enddate: 1796083200 },
  { id: 202, shortname: "CS-202", fullname: "Data Structures", visible: 1, startdate: 1788220800, enddate: 1796083200 },
];

const ASSIGNMENTS = {
  courses: [
    {
      id: 101,
      shortname: "MATH-101",
      fullname: "Linear Algebra Basics",
      assignments: [
        { id: 9001, cmid: 5001, course: 101, name: "Problem set 1", duedate: 1790035200, intro: "<p>Vectors and spans.</p>" },
        { id: 9002, cmid: 5002, course: 101, name: "Problem set 2", duedate: 1791244800, intro: "<p>Matrices.</p>" },
      ],
    },
    {
      id: 202,
      shortname: "CS-202",
      fullname: "Data Structures",
      assignments: [
        { id: 9003, cmid: 5003, course: 202, name: "Lab 1: linked lists", duedate: 1790640000, intro: "<p>Implement a list.</p>" },
      ],
    },
  ],
  warnings: [],
};

function courseContents(courseid) {
  if (Number(courseid) !== 101) return [];
  return [
    {
      id: 1,
      name: "Week 1",
      modules: [
        {
          id: 6001,
          name: "Lecture 1 slides",
          modname: "resource",
          contents: [
            {
              type: "file",
              filename: "lecture1.pdf",
              filesize: 12345,
              mimetype: "application/pdf",
              fileurl: "/webservice/pluginfile.php/1/mod_resource/content/1/lecture1.pdf",
              timemodified: 1788307200,
            },
          ],
        },
      ],
    },
  ];
}

function wsError(errorcode, message, exception = "moodle_exception") {
  return { exception, errorcode, message };
}

function restAnswer(fn, params) {
  switch (fn) {
    case "core_webservice_get_site_info":
      return SITE_INFO;
    case "core_enrol_get_users_courses":
      return COURSES;
    case "mod_assign_get_assignments":
      return ASSIGNMENTS;
    case "core_course_get_contents":
      return courseContents(params.courseid);
    case "mock_echo_params":
      // Test helper: answers with the flattened params it received.
      return params;
    default:
      return wsError("invalidrecord", "Can't find data record in database table external_functions.", "dml_missing_record_exception");
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url, "http://mock.local");
  const path = url.pathname;

  if (req.method === "POST" && path === "/webservice/rest/server.php") {
    const form = new URLSearchParams((await readBody(req)).toString("utf8"));
    if (form.get("moodlewsrestformat") !== "json") return send(res, 200, "<xml/>", { "content-type": "text/xml" });
    if (form.get("wstoken") !== MOCK_TOKEN) return send(res, 200, wsError("invalidtoken", "Invalid token - token not found"));
    const params = {};
    for (const [k, v] of form) {
      if (k !== "wstoken" && k !== "wsfunction" && k !== "moodlewsrestformat") params[k] = v;
    }
    return send(res, 200, restAnswer(form.get("wsfunction"), params));
  }

  if (req.method === "POST" && path === "/webservice/upload.php") {
    const buf = await readBody(req);
    const form = await new Response(buf, { headers: { "content-type": req.headers["content-type"] || "" } }).formData();
    if (form.get("token") !== MOCK_TOKEN) return send(res, 200, { error: "Invalid token", errorcode: "invalidtoken" });
    const file = form.get("file_1");
    if (!file || typeof file === "string") return send(res, 200, { error: "No file", errorcode: "nofile" });
    return send(res, 200, [
      { component: "user", contextid: 5, userid: String(MOCK_USERID), filearea: "draft", filename: file.name, filepath: "/", itemid: 777001, license: "allrightsreserved", author: "Test Student", source: "" },
    ]);
  }

  if (req.method === "GET" && path === "/admin/tool/mobile/launch.php") {
    const scheme = url.searchParams.get("urlscheme") || "moodlemobile";
    const passport = url.searchParams.get("passport") || "";
    const payload = Buffer.from(`mocksig${passport}:::${MOCK_TOKEN}:::${MOCK_PRIVATE_TOKEN}`).toString("base64");
    res.writeHead(303, { location: `${scheme}://token=${payload}` });
    return res.end();
  }

  if (req.method === "POST" && path === "/lib/ajax/service-nologin.php") {
    let calls;
    try {
      calls = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      return send(res, 200, { error: "Invalid JSON", errorcode: "invalidjson" });
    }
    const out = calls.map((c) => {
      if (c.methodname !== "tool_mobile_get_tokens_for_qr_login") {
        return { error: true, exception: { message: "Web service not available", errorcode: "servicenotavailable" } };
      }
      if (!/moodlemobile/i.test(req.headers["user-agent"] || "")) {
        return { error: true, exception: { message: "Use the Moodle app", errorcode: "apprequired" } };
      }
      if (c.args?.qrloginkey !== MOCK_QR_KEY || Number(c.args?.userid) !== MOCK_USERID) {
        return { error: true, exception: { message: "Incorrect key", errorcode: "invalidkey" } };
      }
      return { error: false, data: { token: MOCK_TOKEN, privatetoken: MOCK_PRIVATE_TOKEN, warnings: [] } };
    });
    return send(res, 200, out);
  }

  send(res, 404, { error: "Not found", errorcode: "notfound" });
}

/** Start the mock. port 0 picks a free port. Resolves to { url, port, close }. */
export function startMock({ port = 0, host = "127.0.0.1" } = {}) {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { error: String(err?.message || err), errorcode: "mockerror" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        url: `http://${host}:${actual}`,
        port: actual,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mock = await startMock({ port: Number(process.env.PORT) || 8787 });
  process.stdout.write(`Mock Moodle listening on ${mock.url} (token: MOCK_TOKEN in scripts/moodle/mock.mjs)\n`);
}

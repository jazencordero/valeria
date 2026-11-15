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

// ---- Lecture PDFs (M0-14), only with startMock({ lectures: true }) --------------------
// Adds two courses (CS-C3120 with lecture PDFs, CS-C3100 so "CS-C31" is ambiguous), their
// contents and token downloads from /webservice/pluginfile.php. Without the option every
// answer above is unchanged.

export const LECTURE_COURSES = [
  { id: 303, shortname: "CS-C3120", fullname: "Human-Computer Interaction", visible: 1, startdate: 1788220800, enddate: 1796083200 },
  { id: 304, shortname: "CS-C3100", fullname: "Computer Graphics", visible: 1, startdate: 1788220800, enddate: 1796083200 },
];

const tinyPdf = (title) =>
  Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${title}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, "utf8");

const PF = "/webservice/pluginfile.php";
/** Files the mock serves, by path. */
export const LECTURE_FILES = {
  [`${PF}/31/mod_resource/content/1/overview.pdf`]: tinyPdf("Course overview"),
  [`${PF}/32/mod_resource/content/1/lecture1.pdf`]: tinyPdf("Lecture 1: what is HCI"),
  [`${PF}/33/mod_folder/content/0/ex1.pdf`]: tinyPdf("Exercise 1"),
  [`${PF}/33/mod_folder/content/0/ex2.PDF`]: tinyPdf("Exercise 2, a longer one"),
  [`${PF}/33/mod_folder/content/0/notes.docx`]: Buffer.from("not a pdf"),
  [`${PF}/34/mod_resource/content/1/draft.pdf`]: tinyPdf("Hidden draft"),
  [`${PF}/36/mod_resource/content/1/lecture3.pdf`]: tinyPdf("Lecture 3"),
};

const lectureFile = (path, mimetype, extra = {}) => ({
  type: "file",
  filename: path.split("/").pop(),
  filepath: "/",
  filesize: LECTURE_FILES[path]?.length ?? 0,
  mimetype,
  fileurl: path,
  timemodified: 1788307200,
  ...extra,
});

function lectureContents(courseid) {
  if (Number(courseid) !== 303) return Number(courseid) === 304 ? [] : undefined;
  return [
    {
      id: 30, section: 0, name: "General",
      modules: [
        { id: 7001, name: "Course overview", modname: "resource", uservisible: true, contents: [lectureFile(`${PF}/31/mod_resource/content/1/overview.pdf`, "application/pdf")] },
        { id: 7002, name: "Course page", modname: "url", uservisible: true, contents: [{ type: "url", filename: "Course page", fileurl: "https://example.org" }] },
      ],
    },
    {
      id: 31, section: 1, name: "Week 1",
      modules: [
        { id: 7003, name: "Lecture 1: What is HCI?", modname: "resource", uservisible: true, contents: [lectureFile(`${PF}/32/mod_resource/content/1/lecture1.pdf`, "application/pdf")] },
        {
          id: 7004, name: "Exercise sheets", modname: "folder", uservisible: true,
          contents: [
            lectureFile(`${PF}/33/mod_folder/content/0/ex1.pdf`, "application/pdf"),
            lectureFile(`${PF}/33/mod_folder/content/0/notes.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            lectureFile(`${PF}/33/mod_folder/content/0/ex2.PDF`, ""),
          ],
        },
        { id: 7005, name: "Hidden draft", modname: "resource", uservisible: false, contents: [lectureFile(`${PF}/34/mod_resource/content/1/draft.pdf`, "application/pdf")] },
      ],
    },
    {
      id: 32, section: 2, name: "Week 2",
      modules: [
        // Says 40 MB; never served at that size. The script must skip it on filesize alone.
        { id: 7006, name: "Lecture 2 full recording slides", modname: "resource", uservisible: true, contents: [lectureFile(`${PF}/35/mod_resource/content/1/lecture2.pdf`, "application/pdf", { filesize: 40 * 1024 * 1024 })] },
        { id: 7007, name: "Lecture 3", modname: "resource", uservisible: true, contents: [lectureFile(`${PF}/36/mod_resource/content/1/lecture3.pdf`, "application/pdf")] },
      ],
    },
  ];
}

function lectureAnswer(fn, params) {
  if (fn === "core_enrol_get_users_courses") return [...COURSES, ...LECTURE_COURSES];
  if (fn === "core_course_get_contents") return lectureContents(params.courseid);
  return undefined;
}

// ---- Hand-in test (M0-04), only with startMock({ handin: true }) ----------------------
// Adds submissiondrafts + configs to assignments and answers the three write/read calls
// the hand-in test uses. Without the option every answer above is unchanged.

const fileCfg = (enabled) => [
  { plugin: "file", subtype: "assignsubmission", name: "enabled", value: enabled ? "1" : "0" },
  { plugin: "file", subtype: "assignsubmission", name: "maxfilesubmissions", value: "1" },
  { plugin: "file", subtype: "assignsubmission", name: "maxsubmissionsizebytes", value: "1048576" },
  { plugin: "onlinetext", subtype: "assignsubmission", name: "enabled", value: enabled ? "0" : "1" },
];

// 9001: separate Submit button. 9002: saving counts as handing in. 9003: online text only.
const HANDIN_DETAILS = {
  9001: { submissiondrafts: 1, requiresubmissionstatement: 1, configs: fileCfg(true) },
  9002: { submissiondrafts: 0, requiresubmissionstatement: 0, configs: fileCfg(true) },
  9003: { submissiondrafts: 1, requiresubmissionstatement: 0, configs: fileCfg(false) },
};

function handinAssignments() {
  return {
    ...ASSIGNMENTS,
    courses: ASSIGNMENTS.courses.map((c) => ({
      ...c,
      assignments: c.assignments.map((a) => ({ ...a, ...HANDIN_DETAILS[a.id] })),
    })),
  };
}

function handinAnswer(fn, params, state) {
  switch (fn) {
    case "mod_assign_get_assignments":
      return handinAssignments();
    case "mod_assign_save_submission": {
      const id = Number(params.assignmentid);
      if (!HANDIN_DETAILS[id]) return wsError("invalidrecord", "Can't find data record in database table assign.", "dml_missing_record_exception");
      const itemid = params["plugindata[files_filemanager]"];
      const draft = state.drafts.get(String(itemid));
      if (!draft) return [{ item: "", itemid: id, warningcode: "couldnotsavesubmission", message: "No files in the draft area." }];
      state.submissions.set(id, { status: HANDIN_DETAILS[id].submissiondrafts ? "draft" : "submitted", files: [draft] });
      return [];
    }
    case "mod_assign_get_submission_status": {
      const id = Number(params.assignid);
      if (!HANDIN_DETAILS[id]) return wsError("invalidrecord", "Can't find data record in database table assign.", "dml_missing_record_exception");
      const sub = state.submissions.get(id) || { status: "new", files: [] };
      return {
        lastattempt: {
          submission: {
            id: 880000 + id,
            userid: MOCK_USERID,
            status: sub.status,
            plugins: [
              {
                type: "file",
                name: "File submissions",
                fileareas: [{ area: "submission_files", files: sub.files.map((f) => ({ filename: f.filename, filepath: "/", filesize: f.filesize })) }],
              },
            ],
          },
          submissionsenabled: true,
          caneditowner: true,
          cansubmit: sub.status === "draft",
        },
        warnings: [],
      };
    }
    case "mod_assign_submit_for_grading": {
      const id = Number(params.assignmentid);
      const sub = state.submissions.get(id);
      if (!sub) return [{ item: "", itemid: id, warningcode: "couldnotsubmitforgrading", message: "Nothing to submit." }];
      if (HANDIN_DETAILS[id].requiresubmissionstatement && params.acceptsubmissionstatement !== "1") {
        return [{ item: "", itemid: id, warningcode: "couldnotsubmitforgrading", message: "You must accept the submission statement." }];
      }
      sub.status = "submitted";
      return [];
    }
    default:
      return undefined;
  }
}

// ---- Hand-in status and grades (M0-16), only with startMock({ account: true }) --------
// Adds due/cut-off dates, drafts and group settings to the assignments (plus a group lab
// 9004 and an untouched essay 9005 in CS-202), one submission status per assignment and
// grade items per course. The grade report also carries ANOTHER user's entry, and both
// carry feedback text, so the reader's filtering can be tested. `account: { failStatus:
// [ids], failGrades: [courseids] }` makes those calls answer with an error.
// Without the option every answer above is unchanged.

export const OTHER_USERID = 43;
export const ACCOUNT_FEEDBACK = "Mock feedback text: nice work on question 3.";

const ACCOUNT_DETAILS = {
  9001: { submissiondrafts: 1, cutoffdate: 1790121600, teamsubmission: 0 },
  9002: { submissiondrafts: 1, cutoffdate: 0, teamsubmission: 0 },
  9003: { submissiondrafts: 0, cutoffdate: 0, teamsubmission: 0 },
};
const ACCOUNT_EXTRA = [
  { id: 9004, cmid: 5004, course: 202, name: "Lab 2: trees (group)", duedate: 1791849600, cutoffdate: 0, submissiondrafts: 0, teamsubmission: 1, intro: "<p>In pairs.</p>" },
  { id: 9005, cmid: 5005, course: 202, name: "Optional essay", duedate: 0, cutoffdate: 0, submissiondrafts: 0, teamsubmission: 0, intro: "" },
];

function accountAssignments() {
  return {
    ...ASSIGNMENTS,
    courses: ASSIGNMENTS.courses.map((c) => ({
      ...c,
      assignments: [
        ...c.assignments.map((a) => ({ ...a, ...ACCOUNT_DETAILS[a.id] })),
        ...ACCOUNT_EXTRA.filter((a) => a.course === c.id),
      ],
    })),
  };
}

const submission = (id, status, timemodified, files = [], userid = MOCK_USERID) => ({
  id: 880000 + id,
  userid,
  status,
  timemodified,
  groupid: 0,
  plugins: [
    {
      type: "file",
      name: "File submissions",
      fileareas: [
        {
          area: "submission_files",
          files: files.map(([filename, filesize]) => ({
            filename,
            filepath: "/",
            filesize,
            fileurl: `http://mock.local/webservice/pluginfile.php/9/assignsubmission_file/submission_files/${880000 + id}/${filename}`,
          })),
        },
      ],
    },
    { type: "comments", name: "Submission comments" },
  ],
});

const ACCOUNT_STATUS = {
  // Handed in and graded, with feedback text that must not be kept.
  9001: {
    lastattempt: { submission: submission(9001, "submitted", 1789948800, [["ps1.pdf", 204800]]), submissionsenabled: true, graded: true, gradingstatus: "graded", canedit: false },
    feedback: {
      grade: { id: 1, assignment: 9001, userid: MOCK_USERID, grader: 7, grade: "18.00000" },
      gradefordisplay: "18.00&nbsp;/&nbsp;20.00",
      gradeddate: 1790300000,
      plugins: [{ type: "comments", name: "Feedback comments", editorfields: [{ name: "comments", text: ACCOUNT_FEEDBACK, format: 1 }] }],
    },
  },
  // Saved as a draft; Submit not pressed.
  9002: { lastattempt: { submission: submission(9002, "draft", 1790900000, [["ps2-draft.pdf", 1500]]), submissionsenabled: true, graded: false, gradingstatus: "notgraded", canedit: true } },
  // Never started.
  9003: { lastattempt: { submission: submission(9003, "new", 0), submissionsenabled: true, graded: false, gradingstatus: "notgraded", canedit: true } },
  // Group hand-in: her own submission stays "new", the group's is the one that counts.
  9004: {
    lastattempt: {
      submission: submission(9004, "new", 0),
      teamsubmission: submission(9004, "submitted", 1791700000, [["trees.zip", 3 * 1024 * 1024]], 0),
      submissiongroupmemberswhoneedtosubmit: [OTHER_USERID],
      submissionsenabled: true,
      graded: true,
      gradingstatus: "graded",
      canedit: false,
    },
  },
  // Nothing at all.
  9005: { warnings: [] },
};

const gradeItem = (id, itemname, itemtype, extra = {}) => ({
  id,
  itemname,
  itemtype,
  itemmodule: null,
  iteminstance: null,
  graderaw: null,
  grademin: 0,
  grademax: 100,
  gradedategraded: null,
  gradeishidden: false,
  gradehiddenbydate: false,
  feedback: "",
  ...extra,
});

function accountGrades(courseid, userid, fullname, offset) {
  const g = (n) => (n === null ? null : n - offset);
  if (Number(courseid) === 101) {
    return {
      courseid: 101,
      userid,
      userfullname: fullname,
      gradeitems: [
        gradeItem(41, "Problem set 1", "mod", { itemmodule: "assign", iteminstance: 9001, cmid: 5001, graderaw: g(18), grademax: 20, weightraw: 0.4, gradedategraded: 1790300000, feedback: ACCOUNT_FEEDBACK }),
        gradeItem(42, "Problem set 2", "mod", { itemmodule: "assign", iteminstance: 9002, cmid: 5002, grademax: 20, weightraw: 0.4 }),
        gradeItem(43, "Midterm exam", "manual", { graderaw: g(30), grademax: 40, gradedategraded: 1790400000, gradeishidden: true }),
        gradeItem(44, "", "category", { graderaw: g(48), grademax: 60 }),
        gradeItem(45, null, "course", { graderaw: g(48), grademax: 60, weightraw: null }),
      ],
    };
  }
  if (Number(courseid) === 202) {
    return {
      courseid: 202,
      userid,
      userfullname: fullname,
      gradeitems: [
        gradeItem(51, "Lab 1: linked lists", "mod", { itemmodule: "assign", iteminstance: 9003, cmid: 5003, grademax: 10 }),
        gradeItem(52, "Lab 2: trees (group)", "mod", { itemmodule: "assign", iteminstance: 9004, cmid: 5004, graderaw: g(9.5), grademax: 10, weightraw: 0.5, gradedategraded: 1791800000 }),
        gradeItem(53, null, "course", { graderaw: g(9.5), grademax: 20 }),
      ],
    };
  }
  return null;
}

function accountAnswer(fn, params, account) {
  const fail = typeof account === "object" && account ? account : {};
  switch (fn) {
    case "mod_assign_get_assignments":
      return accountAssignments();
    case "mod_assign_get_submission_status": {
      const id = Number(params.assignid);
      if ((fail.failStatus || []).includes(id)) return wsError("nopermissions", "Sorry, but you do not currently have permissions to do that.", "required_capability_exception");
      if (!ACCOUNT_STATUS[id]) return wsError("invalidrecord", "Can't find data record in database table assign.", "dml_missing_record_exception");
      return ACCOUNT_STATUS[id];
    }
    case "gradereport_user_get_grade_items": {
      const courseid = Number(params.courseid);
      if ((fail.failGrades || []).includes(courseid)) return wsError("nopermissions", "Sorry, but you do not currently have permissions to do that.", "required_capability_exception");
      const mine = accountGrades(courseid, MOCK_USERID, "Test Student", 0);
      if (!mine) return wsError("invalidcourseid", "You are not enrolled in this course.");
      // Another student's entry first, as if the site leaked it: the reader must skip it.
      return { usergrades: [accountGrades(courseid, OTHER_USERID, "Other Student", -1), mine], warnings: [] };
    }
    default:
      return undefined;
  }
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

async function handle(req, res, opts, state) {
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
    const fn = form.get("wsfunction");
    state.calls.push({ fn, params });
    let special = opts.handin ? handinAnswer(fn, params, state) : undefined;
    if (special === undefined && opts.lectures) special = lectureAnswer(fn, params);
    if (special === undefined && opts.account) special = accountAnswer(fn, params, opts.account);
    return send(res, 200, special !== undefined ? special : restAnswer(fn, params));
  }

  if (req.method === "POST" && path === "/webservice/upload.php") {
    const buf = await readBody(req);
    const form = await new Response(buf, { headers: { "content-type": req.headers["content-type"] || "" } }).formData();
    if (form.get("token") !== MOCK_TOKEN) return send(res, 200, { error: "Invalid token", errorcode: "invalidtoken" });
    const file = form.get("file_1");
    if (!file || typeof file === "string") return send(res, 200, { error: "No file", errorcode: "nofile" });
    state.calls.push({ fn: "upload", params: { filename: file.name, filesize: file.size } });
    state.drafts.set("777001", { filename: file.name, filesize: file.size });
    return send(res, 200, [
      { component: "user", contextid: 5, userid: String(MOCK_USERID), filearea: "draft", filename: file.name, filepath: "/", itemid: 777001, license: "allrightsreserved", author: "Test Student", source: "" },
    ]);
  }

  if (opts.lectures && req.method === "GET" && path.startsWith(`${PF}/`)) {
    if (url.searchParams.get("token") !== MOCK_TOKEN) return send(res, 200, { error: "Invalid token", errorcode: "invalidtoken" });
    state.calls.push({ fn: "download", params: { path } });
    const bytes = LECTURE_FILES[path];
    if (!bytes) return send(res, 404, { error: "File not found", errorcode: "filenotfound" });
    res.writeHead(200, { "content-type": path.endsWith(".docx") ? "application/octet-stream" : "application/pdf", "content-length": bytes.length });
    return res.end(bytes);
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

/**
 * Start the mock. port 0 picks a free port. Resolves to { url, port, close, calls }.
 * `calls` logs every REST call ({ fn, params }) and every upload ({ fn: "upload" }).
 * `handin: true` turns on the hand-in answers (see handinAnswer).
 * `lectures: true` turns on the lecture PDF courses and downloads (see lectureAnswer).
 * `account: true` (or { failStatus, failGrades }) turns on hand-in statuses and grades (see accountAnswer).
 */
export function startMock({ port = 0, host = "127.0.0.1", handin = false, lectures = false, account = false } = {}) {
  const state = { calls: [], drafts: new Map(), submissions: new Map() };
  const server = createServer((req, res) => {
    handle(req, res, { handin, lectures, account }, state).catch((err) => send(res, 500, { error: String(err?.message || err), errorcode: "mockerror" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        url: `http://${host}:${actual}`,
        port: actual,
        calls: state.calls,
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { createScrubber, scrub, USER_ID_KEYS, NAME_KEYS } from "./scrub.mjs";

// Invented answers, shaped like real Moodle 4.x responses. No real people.
const TOKEN = "f3a9c1e07b5d4a2e9c8b7a6d5e4f3a21";
const PRIVATE_KEY = "Zq8KpL2mNx7Rt4Vw";
const USERID = 48213;
const TEACHER_ID = 7302;

const siteInfo = () => ({
  sitename: "Example University MyCourses",
  username: "kowalsm9",
  firstname: "Marjatta",
  lastname: "Kowalski-Brandt",
  fullname: "Marjatta Kowalski-Brandt",
  lang: "en",
  userid: USERID,
  siteurl: "https://mycourses.example.edu",
  userpictureurl: `https://mycourses.example.edu/webservice/pluginfile.php/991/user/icon/boost/f1?rev=3&token=${TOKEN}`,
  functions: [
    { name: "core_webservice_get_site_info", version: "2024100700" },
    { name: "mod_assign_get_submission_status", version: "2024100700" },
  ],
  downloadfiles: 1,
  uploadfiles: 1,
  release: "4.5.2 (Build: 20250210)",
  version: "2024100702.00",
  mobilecssurl: "",
  advancedfeatures: [{ name: "usecomments", value: 1 }],
  usercanmanageownfiles: true,
  userquota: 104857600,
  usermaxuploadfilesize: 52428800,
  userhomepage: 1,
  userprivateaccesskey: PRIVATE_KEY,
  siteid: 1,
  sitecalendartype: "gregorian",
  usercalendartype: "gregorian",
  userissiteadmin: false,
  theme: "boost",
  limitconcurrentlogins: 0,
  policyagreed: 1,
});

const submissionStatus = () => ({
  lastattempt: {
    submission: {
      id: 3001,
      userid: USERID,
      attemptnumber: 0,
      timecreated: 1789000000,
      timemodified: 1789003600,
      timestarted: null,
      status: "submitted",
      groupid: 0,
      assignment: 77,
      latest: 1,
      plugins: [
        {
          type: "file",
          name: "File submissions",
          fileareas: [
            {
              area: "submission_files",
              files: [
                {
                  filename: "essay-week3.pdf",
                  filepath: "/",
                  filesize: 182733,
                  fileurl: `https://mycourses.example.edu/webservice/pluginfile.php/55/assignsubmission_file/submission_files/3001/essay-week3.pdf?forcedownload=1&token=${TOKEN}`,
                  timemodified: 1789003500,
                  mimetype: "application/pdf",
                  isexternalfile: false,
                },
              ],
            },
          ],
        },
        {
          type: "onlinetext",
          name: "Online text",
          editorfields: [{ name: "onlinetext", description: "Online text", text: "<p>My answer, by Marjatta.</p>", format: 1 }],
        },
      ],
    },
    teamsubmission: { id: 0, userid: 0, status: "new" },
    submissiongroupmemberswhoneedtosubmit: [],
    submissionsenabled: true,
    locked: false,
    graded: true,
    canedit: false,
    cansubmit: false,
    extensionduedate: null,
    timelimit: 0,
    blindmarking: false,
    gradingstatus: "graded",
    usergroups: [],
  },
  feedback: {
    grade: {
      id: 4001,
      assignment: 77,
      userid: USERID,
      attemptnumber: 0,
      timecreated: 1789100000,
      timemodified: 1789100500,
      grader: TEACHER_ID,
      grade: "8.50000",
    },
    gradefordisplay: "8.50 / 10.00",
    gradeddate: 1789100500,
    plugins: [
      {
        type: "comments",
        name: "Feedback comments",
        editorfields: [
          {
            name: "comments",
            description: "Feedback comments",
            text: "<p>Good work Marjatta, see me about section 2. - Dr. Okonkwo-Lindqvist</p>",
            format: 1,
          },
        ],
      },
    ],
  },
  warnings: [],
});

const ORIGINALS = ["Marjatta", "Kowalski-Brandt", "Marjatta Kowalski-Brandt", "kowalsm9", String(USERID), String(TEACHER_ID), TOKEN, PRIVATE_KEY, "Okonkwo-Lindqvist", "My answer"];

test("site_info and submission_status come out with none of the original personal strings", () => {
  const s = createScrubber();
  const out = JSON.stringify([s(siteInfo()), s(submissionStatus())]);
  for (const o of ORIGINALS) assert.ok(!out.includes(o), `still contains ${o}`);
});

test("site_info keeps site data and fakes the person", () => {
  const out = createScrubber()(siteInfo());
  assert.equal(out.sitename, "Example University MyCourses");
  assert.equal(out.siteurl, "https://mycourses.example.edu");
  assert.equal(out.release, "4.5.2 (Build: 20250210)");
  assert.deepEqual(out.functions, siteInfo().functions);
  assert.equal(out.siteid, 1);
  assert.equal(out.firstname, "First1");
  assert.equal(out.lastname, "Last1");
  assert.equal(out.fullname, "Person 1");
  assert.equal(out.username, "user1");
  assert.ok(out.userid > 900000);
  assert.equal(out.userprivateaccesskey, "REDACTED");
  assert.ok(out.userpictureurl.startsWith("https://example.invalid/"));
});

test("submission_status keeps assignment structure, grades and file names", () => {
  const out = createScrubber()(submissionStatus());
  const sub = out.lastattempt.submission;
  assert.equal(sub.id, 3001);
  assert.equal(sub.assignment, 77);
  assert.equal(sub.status, "submitted");
  assert.equal(sub.timemodified, 1789003600);
  const file = sub.plugins[0].fileareas[0].files[0];
  assert.equal(file.filename, "essay-week3.pdf");
  assert.ok(file.fileurl.includes("/essay-week3.pdf?forcedownload=1&token=REDACTED"));
  assert.equal(out.feedback.grade.id, 4001);
  assert.equal(out.feedback.grade.grade, "8.50000");
  assert.equal(out.feedback.gradefordisplay, "8.50 / 10.00");
  assert.equal(out.feedback.plugins[0].name, "Feedback comments");
  assert.match(out.feedback.plugins[0].editorfields[0].text, /^Scrubbed text \d+\.$/);
  assert.equal(out.lastattempt.teamsubmission.userid, 0, "0 means nobody and stays");
});

test("one user id gets the same fake everywhere, across calls in one run", () => {
  const s = createScrubber();
  const info = s(siteInfo());
  const status = s(submissionStatus());
  assert.equal(status.lastattempt.submission.userid, info.userid);
  assert.equal(status.feedback.grade.userid, info.userid);
  assert.notEqual(status.feedback.grade.grader, info.userid);
  // Same name in a second answer maps to the same fake.
  assert.equal(s({ users: [{ id: USERID, fullname: "Marjatta Kowalski-Brandt" }] }).users[0].fullname, info.fullname);
  assert.equal(s({ users: [{ id: USERID }] }).users[0].id, info.userid);
});

test("numeric-string user ids keep their type", () => {
  const out = createScrubber()({ userid: "48213", component: "user" });
  assert.equal(typeof out.userid, "string");
  assert.notEqual(out.userid, "48213");
});

test("course fullname and ids are not treated as a person", () => {
  const courses = [{ id: 101, shortname: "MATH-101", fullname: "Linear Algebra Basics", displayname: "Linear Algebra Basics", courseid: 101 }];
  assert.deepEqual(createScrubber()(courses), courses);
});

test("people nested in courses (contacts) and forum authors are scrubbed, ids included", () => {
  const out = createScrubber()({
    courses: [{ id: 101, fullname: "Linear Algebra Basics", contacts: [{ id: TEACHER_ID, fullname: "Dr. Okonkwo-Lindqvist" }] }],
    posts: [{ id: 9, subject: "Re: week 3", author: { id: USERID, fullname: "Marjatta Kowalski-Brandt" } }],
  });
  assert.equal(out.courses[0].id, 101);
  assert.equal(out.courses[0].fullname, "Linear Algebra Basics");
  assert.notEqual(out.courses[0].contacts[0].id, TEACHER_ID);
  assert.ok(!JSON.stringify(out).includes("Okonkwo"));
  assert.notEqual(out.posts[0].author.id, USERID);
  assert.equal(out.posts[0].id, 9);
});

test("known names are swept out of other strings, whole words only", () => {
  const s = createScrubber();
  const out = s({ firstname: "Ann", lastname: "Lee", fullname: "Ann Lee", note: "Ann Lee wrote this", course: "Annual Report Lee-side" });
  assert.equal(out.note, "Person 1 wrote this");
  assert.equal(out.course, "Annual Report Lee-side".replace("Lee", "Last1"));
});

test("tokens in any URL are removed; JSON strings in, JSON strings out", () => {
  const raw = JSON.stringify({ url: `https://x.example/webservice/rest/server.php?wstoken=${TOKEN}&moodlewsrestformat=json` });
  const out = createScrubber()(raw);
  assert.equal(typeof out, "string");
  assert.ok(!out.includes(TOKEN));
  assert.ok(out.includes("wstoken=REDACTED&moodlewsrestformat=json"));
});

test("does not mutate its input; shared scrub is stable across calls", () => {
  const input = siteInfo();
  const before = JSON.stringify(input);
  const a = scrub(input);
  const b = scrub(siteInfo());
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(a, b);
});

test("the personal key lists are exported", () => {
  assert.ok(USER_ID_KEYS.includes("userid"));
  assert.ok(NAME_KEYS.includes("firstname"));
});

test("an email address inside any text is replaced, the same one the same way", () => {
  const s = createScrubber();
  const out = s({
    summary: "<p>Questions: matti.meikalainen@aalto.fi or the course staff.</p>",
    intro: "Send it to matti.meikalainen@aalto.fi before Friday",
  });
  assert.ok(!JSON.stringify(out).includes("meikalainen"));
  assert.equal(out.summary, "<p>Questions: user1@example.invalid or the course staff.</p>");
  assert.equal(out.intro, "Send it to user1@example.invalid before Friday");
});

test("a known name is swept out of a file name joined with underscores", () => {
  const s = createScrubber();
  const out = s({ firstname: "Ann", lastname: "Lee", filename: "Ann_Lee_essay.pdf" });
  assert.equal(out.filename, "First1_Last1_essay.pdf");
});

test("session keys and other key= URL parameters are redacted", () => {
  const s = createScrubber();
  const out = s({
    url: "https://mycourses.example.edu/mod/assign/view.php?id=7&action=editsubmission&sesskey=Kv1xTHEabc",
    html: '<a href="https://x.example/course/view.php?id=3&amp;sesskey=Zz9yQ">x</a>',
    other: "https://x.example/login?qrloginkey=abc123&userid=5",
    sesskey: "Kv1xTHEabc",
  });
  const text = JSON.stringify(out);
  assert.ok(!text.includes("Kv1xTHEabc") && !text.includes("Zz9yQ") && !text.includes("abc123"));
  assert.ok(out.url.endsWith("&sesskey=REDACTED"));
  assert.ok(out.html.includes("&amp;sesskey=REDACTED"));
  assert.equal(out.sesskey, "REDACTED");
});

test("the student number in a grade report is redacted", () => {
  const s = createScrubber();
  const out = s({ usergrades: [{ courseid: 3, userid: 42, userfullname: "Ann Lee", useridnumber: "123456789" }] });
  assert.ok(!JSON.stringify(out).includes("123456789"));
  assert.equal(out.usergrades[0].useridnumber, "REDACTED");
  assert.equal(out.usergrades[0].courseid, 3);
});

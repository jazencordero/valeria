// Scrub people out of Moodle web service answers before they become test fixtures.
// Node 20+, no dependencies. Keeps course names, assignment titles, dates, grades and
// file names, because the app's parsers need them. Not covered (see ticket M0-02 "Cut"):
// names written inside course or assignment descriptions; skim fixtures before committing.

// ---- Keys treated as personal ------------------------------------------------------

/** Always a person's name, wherever it appears. */
export const NAME_KEYS = [
  "firstname",
  "lastname",
  "middlename",
  "alternatename",
  "firstnamephonetic",
  "lastnamephonetic",
  "userfullname",
  "usermodifiedfullname",
  "authorfullname",
  "graderfullname",
];

/** A name only inside a person object (courses also have `fullname`). */
export const PERSON_ONLY_NAME_KEYS = ["fullname", "displayname"];

/** Always a login name. */
export const USERNAME_KEYS = ["username"];

/** Always an email address. */
export const EMAIL_KEYS = ["email"];

/** Always a profile picture URL. */
export const PICTURE_KEYS = ["userpictureurl", "profileimageurl", "profileimageurlsmall", "userprofileimageurl"];

/** Always a user id (number or numeric string). `courseid`, `assignmentid` etc. are left alone. */
export const USER_ID_KEYS = ["userid", "useridfrom", "useridto", "relateduserid", "usermodified", "grader", "authorid", "submittedby"];

/** Inside a person object these are personal too: `id` is the user id, `idnumber` the student number. */
export const PERSON_ID_KEYS = ["id"];
export const PERSON_EXTRA_KEYS = ["idnumber", "phone1", "phone2", "address", "city", "institution", "department", "description", "url"];

/** Free text written by or about a person (teacher feedback, comments). */
export const FREE_TEXT_KEYS = ["feedback", "feedbacktext", "feedbackcomments", "commenttext"];

/** Secrets. Also any `token=` / `wstoken=` / `privatetoken=` / `sesskey=` / `…key=` inside any string. */
export const SECRET_KEYS = ["token", "wstoken", "privatetoken", "userprivateaccesskey", "sesskey"];

/** Keys whose object value (or array of objects) is a person. */
export const PERSON_CONTAINER_KEYS = ["user", "users", "participant", "participants", "members", "contacts", "author", "teachers", "students", "enrolledusers", "userfrom", "userto"];

/** Keys whose presence marks an object as a person. */
const PERSON_MARKERS = ["firstname", "lastname", "email", "username", "profileimageurl", "profileimageurlsmall", "userpictureurl"];

const set = (a) => new Set(a);
const S = {
  name: set(NAME_KEYS),
  personName: set(PERSON_ONLY_NAME_KEYS),
  username: set(USERNAME_KEYS),
  email: set(EMAIL_KEYS),
  picture: set(PICTURE_KEYS),
  userId: set(USER_ID_KEYS),
  personId: set(PERSON_ID_KEYS),
  personExtra: set(PERSON_EXTRA_KEYS),
  freeText: set(FREE_TEXT_KEYS),
  secret: set(SECRET_KEYS),
  container: set(PERSON_CONTAINER_KEYS),
  marker: set(PERSON_MARKERS),
};

const FAKE_USER_ID_BASE = 900000;
// Session keys (`sesskey=`, in calendar action URLs) and any `…key=` parameter count too.
const TOKEN_IN_TEXT = /\b(wstoken|privatetoken|token|[a-z]*key)=([^&#"'\s]+)/gi;
const USERID_IN_URL = /([?&](?:userid|user|id_user)=)(\d+)/gi;
// Any email address in any text (a teacher's address in a course summary, say).
const EMAIL_IN_TEXT = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

// ---- Scrubber -------------------------------------------------------------------------

/**
 * A scrubber with its own memory: the same real value always gets the same fake,
 * so a user id in `userid`, in `submission.userid` and in `user.id` still lines up.
 */
export function createScrubber() {
  const maps = new Map(); // kind -> Map(real -> fake)
  const userIds = new Map(); // "123" -> 900001
  const seenStrings = new Map(); // real personal string -> fake, for the second pass

  function fakeFor(kind, real, make) {
    if (!maps.has(kind)) maps.set(kind, new Map());
    const m = maps.get(kind);
    const key = String(real);
    if (!m.has(key)) m.set(key, make(m.size + 1));
    const fake = m.get(key);
    if (typeof real === "string" && real.trim().length >= 3) seenStrings.set(real, fake);
    return fake;
  }

  function fakeUserId(real) {
    const n = Number(real);
    // 0 and negatives mean "nobody" in Moodle; keep them. Keep non-numbers as they are.
    if (real === null || real === "" || !Number.isFinite(n) || n <= 0) return real;
    const key = String(n);
    if (!userIds.has(key)) userIds.set(key, FAKE_USER_ID_BASE + userIds.size + 1);
    const fake = userIds.get(key);
    return typeof real === "string" ? String(fake) : fake;
  }

  const fakeName = (v, kind) => (typeof v === "string" && v ? fakeFor(kind, v, (n) => fakeNameText(kind, n)) : v);

  function fakeNameText(kind, n) {
    if (kind === "firstname") return `First${n}`;
    if (kind === "lastname") return `Last${n}`;
    return `Person ${n}`;
  }

  function scrubText(s) {
    return s
      .replace(TOKEN_IN_TEXT, (_, k) => `${k}=REDACTED`)
      .replace(USERID_IN_URL, (_, k, id) => `${k}${fakeUserId(id)}`)
      .replace(EMAIL_IN_TEXT, (m) => fakeFor("email", m, (n) => `user${n}@example.invalid`));
  }

  function scrubValue(key, value, inPerson) {
    const k = key.toLowerCase();
    if (S.secret.has(k)) return typeof value === "string" && value ? "REDACTED" : value;
    if (S.userId.has(k) && (typeof value === "number" || typeof value === "string")) return fakeUserId(value);
    if (inPerson && S.personId.has(k) && (typeof value === "number" || typeof value === "string")) return fakeUserId(value);
    if (typeof value !== "string") return undefined; // not handled here, keep walking
    if (S.name.has(k)) return fakeName(value, k === "firstname" || k === "lastname" ? k : "fullname");
    if (inPerson && S.personName.has(k)) return fakeName(value, "fullname");
    if (k === "author") return fakeName(value, "fullname"); // file author is a plain name string
    if (S.username.has(k)) return value ? fakeFor("username", value, (n) => `user${n}`) : value;
    if (S.email.has(k)) return value ? fakeFor("email", value, (n) => `user${n}@example.invalid`) : value;
    if (S.picture.has(k)) return value ? fakeFor("picture", value, (n) => `https://example.invalid/pix/u/${n}.png`) : value;
    if (S.freeText.has(k)) return value ? fakeFor("text", value, (n) => `Scrubbed text ${n}.`) : value;
    if (inPerson && S.personExtra.has(k)) return value ? fakeFor(`extra:${k}`, value, (n) => `${k}${n}`) : value;
    return undefined;
  }

  function isPerson(obj, parentKey) {
    if (parentKey && S.container.has(parentKey.toLowerCase())) return true;
    return Object.keys(obj).some((k) => S.marker.has(k.toLowerCase()));
  }

  function walk(node, parentKey, parentIsEditorFields) {
    if (Array.isArray(node)) return node.map((v) => walk(v, parentKey, parentIsEditorFields));
    if (node && typeof node === "object") {
      const inPerson = isPerson(node, parentKey);
      const out = {};
      for (const [key, value] of Object.entries(node)) {
        // Rich-text fields of assignment plugins: student's online text and teacher's comments.
        if (parentIsEditorFields && key === "text" && typeof value === "string" && value) {
          out[key] = fakeFor("text", value, (n) => `Scrubbed text ${n}.`);
          continue;
        }
        const replaced = scrubValue(key, value, inPerson);
        out[key] = replaced !== undefined ? replaced : walk(value, key, key.toLowerCase() === "editorfields");
      }
      return out;
    }
    return typeof node === "string" ? scrubText(node) : node;
  }

  // Second pass: a name or email we learned in pass one may also sit in another string
  // (a message subject, a file path). Replace longest first so "Ann Lee" wins over "Ann".
  function sweep(node, pairs) {
    if (Array.isArray(node)) return node.map((v) => sweep(v, pairs));
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = sweep(v, pairs);
      return out;
    }
    if (typeof node !== "string") return node;
    let s = node;
    for (const [real, fake, re] of pairs) if (s.includes(real)) s = s.replace(re, String(fake));
    return s;
  }

  // Whole words only, so a first name "Ann" does not turn "Annual Report" into "First1ual Report".
  // An underscore ends a word here: file names like "Ann_Lee_essay.pdf" are common.
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordRe = (s) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(s)}(?![\\p{L}\\p{N}])`, "gu");

  /** Return a scrubbed deep copy of a parsed Moodle answer (object, array or JSON string). */
  return function scrub(json) {
    const input = typeof json === "string" ? JSON.parse(json) : json;
    const first = walk(input, null, false);
    const pairs = [...seenStrings.entries()]
      .sort((a, b) => b[0].length - a[0].length)
      .map(([real, fake]) => [real, fake, wordRe(real)]);
    const out = pairs.length ? sweep(first, pairs) : first;
    return typeof json === "string" ? JSON.stringify(out) : out;
  };
}

/** Shared scrubber for one run (one Node process): fakes stay stable across calls. */
export const scrub = createScrubber();

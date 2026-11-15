# What the MyCourses test showed

From the sitting on 2026-11-14 (M0-07), the read-only probe run against her real account (`probe-report.md`, run 2026-11-14 22:23 UTC), and the server ping from Vercel (M0-06). Hand-in through the test command was not tried (M0-08).

## Getting her key

| Way in | Result |
|---|---|
| QR code from her MyCourses profile, pasted into `probe.mjs --qr` | **Worked.** It exchanged for a key, and all 8 read calls ran on it. |
| "Security keys" page in her preferences | **No usable key.** For a user who never used the Moodle app it lists only an RSS key, no "Moodle mobile web service" key. So "paste your key" does not work for a new user. |
| Launch link (`--launch-url` / `--redirect`) | Not tried. |

So the QR code is the way in. Pasting a key is only a fallback for people who already use the Moodle app.

## What works

- Moodle **5.1.4** (Build 20260420). Her key lists **448** functions.
- All 8 read calls worked: site info, enrolled courses (6), assignments (24), course contents with files (18 files in the first course), one file download (a 99,678-byte PDF, with the key), grade items, calendar action events for the next 60 days (13), and submission status.
- `uploadfiles` and `downloadfiles` are on. Her upload limit is **400 MB** (419,430,400 bytes).
- Allowed: `mod_assign_save_submission`, `mod_assign_submit_for_grading`, `mod_quiz_get_quizzes_by_courses`, `core_calendar_get_calendar_export_token`, `message_popup_get_popup_notifications`.
- Server calls are **not blocked**: the ping from Vercel's Frankfurt region got `typeoflogin: 2` in 214 ms (M0-06).

## What is refused or missing

- `core_files_upload` is not on her key. That doesn't matter: uploads go to `/webservice/upload.php`, which is allowed (`uploadfiles: yes`).
- **Key lifetime is not exposed** by `core_webservice_get_site_info`. We find out it expired when a call answers `invalidtoken`.
- No call was refused.

## Assignments

- All **24** take **files**. None is online text.
- **None** has a separate Submit button (`submissiondrafts` off on all 24). So `mod_assign_save_submission` **is** the hand-in: the moment the file is saved it counts as handed in. There is no draft step to fall back on. The hand-in screen must say so before her tap.
- Max files per assignment range from 1 to 20, mostly 1.
- Hand-in itself is **not yet proven** on her account (M0-08 not tried). It must be tested once before hand-in is trusted.

## Grades

- **0 of 5** grade items in the first course carry a weight. Weights must be typed in by her (M6-04, the weights form, is needed).

## What this changes

- The QR sign-in (M5-05 server side, M5-06 scan or upload) is needed for Milestone 1: the paste-key connect screen (M1-35) cannot work for a real new user.
- The installed-app wrapper (M8-20) stays parked: the QR works from a web page. The laptop launch link (M8-21) stays parked.
- The manual weights form (M6-04) is needed.
- Hand-in stays in the plan, with a real test owed (see M0-08).

## Scrubbing

Every saved answer went through `scripts/moodle/lib/scrub.mjs`. After the sitting a gap was found and fixed: calendar action URLs carried her session key (`sesskey=`) 13 times. The scrubber now redacts `sesskey=` and any `…key=` URL parameter, and the saved answers were scrubbed again.

## Differences from the docs

Found by running the readers against the shape-only copies of her real answers (`tests/fixtures/moodle/`, M1-40). The tests are the `*.real.test.ts` files beside each reader in `src/server/moodle/read/`.

Fixed:

- **Course names start with the code.** MyCourses full names read `ISM-E1005 - Forecasting Methods, Contact teaching, 31.8.2026-12.10.2026`; the docs' samples have no code in front. `getCourses` now drops a leading `<code> - ` (also `–` or `:`), since the code is stored apart. The teaching mode and dates after the name stay, as before.
- **Group assignments.** 5 of her 24 assignments are group assignments (`teamsubmission: 1`, all in FAKE-E9002). For these Moodle puts the group's hand-in in `lastattempt.teamsubmission` and leaves her own `submission` as "new", so she would have shown as not handed in. `getSubmissionStatus` now reads `teamsubmission` when it is there. (Her saved status answer is for an individual assignment; the group case is tested with that answer reshaped as the docs describe.)

Checked, no change needed:

- **Short names** are `<code>_aalto-cur-P-<uuid>`, not `<code> - <name>`. The code reader already stops at the `_`; all 6 codes come out right (ISM-E1005, 37E00200, ISM-E3003, ISM-E2004, FAKE-E9001, FAKE-E9002).
- **Dates** are Unix seconds, and 0 means "not set" (`cutoffdate` and `allowsubmissionsfromdate` are 0 on many). Every `duedate` is set. Times are UTC; no timezone field is sent in site info, courses or assignments, so local times must come from the school.
- **"Needs a Submit press"** is only `submissiondrafts`, at the top level of each assignment, never in `configs`. It is 0 on all 24.
- **`requiresubmissionstatement` is 1 on 3** assignments (all in 37E00200). The readers do not read it. It may matter for hand-in: the hand-in test (M0-08) should try one of these.
- **Max files and size** come from `configs` (`assignsubmission` / `file` / `maxfilesubmissions`, `maxsubmissionsizebytes`) as text, as documented. Max files is 1 on 19, 2 on 1, 4 on 2, 20 on 2. The size limit is 419,430,400 bytes (400 MB, the site limit) on all 24. `filetypeslist` is also there (".pdf", "spreadsheet", "document,.pdf", or empty) and is not read yet.
- **Brief attachments** (`introattachments`) have the documented shape, with `filepath`, `timemodified`, `isexternalfile` and `icon` extra. 24 files across the assignments; URLs carry no key.
- **The `warnings` array** in `mod_assign_get_assignments` holds one entry: `item: module`, `warningcode: "1"`, "No access rights in module context". It names one module she cannot open; that module is simply not in the list. The reader ignores `warnings` and parses fine.
- **Hidden flags.** Every course has `visible: 1` and `hidden: false`; assignments carry no visible flag. Nothing to change.
- **Site info** matches the docs: `release` is there, `uploadfiles` is 1 (a number, not a boolean), `usermaxuploadfilesize` is 419,430,400.
- **Submission status** sends `timestarted` and `extensionduedate` as `null`. The reader does not read them, so it parses.

## Lecture files

From M9-04: `lecturesFrom` (src/lib/courses/lectures.ts) run on the shape-only copy of her first course's page (`core_course_get_contents.json`, read through M2-07's `getCourseContents`; test `src/lib/courses/lectures.real.test.ts`), plus what the planner saw on her real course pages.

What the course page looks like:

- Moodle 5 **subsections**. Section 0 holds a forum and two `subsection` modules; the subsections come back as their own sections (`component: mod_subsection`), one "Assignments" and one "Lecture ...". Their section numbers (1, 2) are not the order the links sit in section 0 (lectures first). The reader does not pass `component` on, so we cannot tell; it does not matter while lectures sit in one section.
- The lecture section holds **six PDFs, one `resource` each, named by topic with no number** (in one course the decks have no lecture numbers anywhere). They are large (1.6 to 12 MB).
- Beside them, **Panopto recordings** as `lti` modules, five of them, three named like a deck. Not files, never lectures.
- In the same section a **folder of ten small PDFs named "Lecture 1.pdf" to "Lecture 10.pdf"** (0.2 to 1 MB). These are the **background readings**, numbered per lecture. So a number, or even the word "lecture", in a file name does not make it a lecture deck.
- The "Assignments" section has two assignments, a folder with one zip, and an **exam results PDF**: in one course a midterm results file lists other students' results. It must never show.

Rules that handle this (each is written next to its code):

- **Order and numbers come from the page**, not from names: sections by position, modules in listed order, a folder's files by natural name order; lectures are numbered 1..n in that order. Numbers in names are only cut from titles.
- **Signal**: a slide file counts when its file, module or section name has a lecture word (lecture, slides, luento, kalvot, week 3, viikko 3, L01, ...) or it is a presentation file (pptx, ppt, key, odp). A topic-named PDF counts only through its section ("Lecture ..."); in a neutral section it does not.
- **Folder beside lectures**: in a section that already has one-resource-per-lecture decks, a folder is extra material and is left out, unless the folder's own name has a lecture word ("Lecture slides"). A folder alone in a section still gives one lecture per file.
- **Readings** are left out by name too: reading, article, literature, chapter, "Ch. 3", "Luku 4", lukemisto, artikkeli, kirjallisuus.
- **Results** are always left out, whatever else the name says: results, grades, gradebook, scores, tulokset, arvosana/arvosanat, pisteet. Exams were already left out.
- **One deck, two formats**: a PDF and a presentation in one section with the same file name, or the same lecture number in both names, are one lecture with the PDF (M9-03's sync relies on this).

Result on her course: the six topic-named decks, numbered 1 to 6 in page order. The readings folder, the results file, the zip and the recordings are left out.

Not checked yet (the ticket's cut is one course):

- Her other five courses. The planner's notes cover one more course's naming; the rest may need rules.
- Whether lectures spread over many "Week n" sections come out right with subsections in between.
- Because numbers now follow page order, a deck the teacher inserts above earlier ones shifts every later number. M9-03 ties a lecture row (and her read mark) to its number, so the read mark would stay on the number, not the file.

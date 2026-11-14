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

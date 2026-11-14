# Moodle probe report

Site: https://mycourses.aalto.fi  
Run: 2026-11-14T22:23:26.451Z  
Read-only. Answers in `fixtures/` went through `scrub()`; raw answers were not saved.

## Calls

| # | Call | Function | Result | ms | Shape | Notes |
|---|---|---|---|---|---|---|
| 1 | Site info | `core_webservice_get_site_info` | worked | 150 | {sitename: string, username: string, firstname: string, lastname: string, fullname: string, lang: string, userid: number, siteurl: string, +20 more} | functions: 448 |
| 2 | Enrolled courses | `core_enrol_get_users_courses` | worked | 392 | [6× {29 keys}] | 6 courses |
| 3 | Assignments | `mod_assign_get_assignments` | worked | 1062 | {courses: array(6), warnings: array(1)} | 24 assignments |
| 4 | Course contents (first course) | `core_course_get_contents` | worked | 174 | [3× {11 keys}] | 18 files |
| 5 | Download one small file | `(pluginfile download)` | worked | 108 | 99678 bytes, application/pdf |  |
| 6 | Grade items (first course) | `gradereport_user_get_grade_items` | worked | 181 | {usergrades: array(1), warnings: array(0)} | 0 of 5 items have a weight |
| 7 | Action events, next 60 days | `core_calendar_get_action_events_by_timesort` | worked | 442 | {events: array(13), firstid: number, lastid: number} | 13 events |
| 8 | Submission status (one assignment) | `mod_assign_get_submission_status` | worked | 155 | {lastattempt: object(13), feedback: object(4), assignmentdata: object(1), warnings: array(0)} | status: submitted |

## Site info

| Field | Value |
|---|---|
| release | 5.1.4 (Build: 20260420) |
| user id | present (value kept out of this report) |
| functions | 448 listed |
| uploadfiles | yes |
| downloadfiles | yes |
| usermaxuploadfilesize | 419430400 |
| key lifetime | not exposed by get_site_info |

## Assignments

| Due | Submission types | Separate Submit button (submissiondrafts) | Max files | Max bytes |
|---|---|---|---|---|
| 2026-10-18 | file | no | 1 | 419430400 |
| 2026-10-18 | file | no | 1 | 419430400 |
| 2026-09-16 | file | no | 2 | 419430400 |
| 2026-09-30 | file | no | 4 | 419430400 |
| 2026-11-11 | file | no | 4 | 419430400 |
| 2026-11-15 | file | no | 1 | 419430400 |
| 2026-11-24 | file | no | 1 | 419430400 |
| 2026-11-01 | file | no | 20 | 419430400 |
| 2026-11-07 | file | no | 20 | 419430400 |
| 2026-12-06 | file | no | 1 | 419430400 |
| 2026-12-06 | file | no | 1 | 419430400 |
| 2026-11-28 | file | no | 1 | 419430400 |
| 2026-11-14 | file | no | 1 | 419430400 |
| 2026-10-24 | file | no | 1 | 419430400 |
| 2026-11-07 | file | no | 1 | 419430400 |
| 2026-10-31 | file | no | 1 | 419430400 |
| 2026-11-21 | file | no | 1 | 419430400 |
| 2026-10-23 | file | no | 1 | 419430400 |
| 2026-10-28 | file | no | 1 | 419430400 |
| 2026-11-04 | file | no | 1 | 419430400 |
| 2026-11-11 | file | no | 1 | 419430400 |
| 2026-11-18 | file | no | 1 | 419430400 |
| 2026-11-23 | file | no | 1 | 419430400 |
| 2026-12-05 | file | no | 1 | 419430400 |

Grade weights: 0 of 5 items have a weight.

## Functions this key may use

| Function | In list |
|---|---|
| `mod_assign_save_submission` | yes |
| `mod_assign_submit_for_grading` | yes |
| `core_files_upload` | no |
| `mod_quiz_get_quizzes_by_courses` | yes |
| `core_calendar_get_calendar_export_token` | yes |
| `message_popup_get_popup_notifications` | yes |

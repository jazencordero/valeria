# Moodle fixtures (shape-only)

Real Moodle web service answers with every human-written word replaced. Use them to test parsers
against the exact shape a live site returns.

## Where they came from

- One real student account on MyCourses (Moodle 5.1.4), probe run 2026-11-14 (ticket M0-02).
- First scrubbed by `scripts/moodle/lib/scrub.mjs` (people, emails, user ids, tokens, session keys).
- Then converted to shape-only copies for ticket M0-09 by a one-off deterministic converter: the
  same real string always got the same fake, in all seven files, so cross-references still line up.

## What was replaced

- Course codes and names: mapped to the prototype's made-up courses, in course-list order
  (ISM-E1005 Forecasting Methods, 37E00200 Strategic IT Management, ISM-E3003 Supply Chain
  Analytics, ISM-E2004 Digital Service Design, FAKE-E9001 Course Five, FAKE-E9002 Course Six).
  Course ids in `shortname`/`idnumber` keep the `<code>_aalto-cur-P-<uuid>` pattern with fake uuids.
- Titles and names (assignments, calendar events, sections, modules, files, grade items):
  topic words became `Topic A`, `Topic B`, ... (one letter per distinct topic). Kind words
  (Lecture, Assignment, Quiz, Exam, Project, Report, ...), numbering, separators, file extensions
  and Moodle suffixes (`is due`, `closes`, `should be completed`) are kept.
- File names inside file URLs follow the same rule.
- All prose (course, section and event descriptions, assignment briefs, category names, any HTML
  text, teacher names and contacts) became Latin filler. Tags and style attributes are kept;
  links to other sites point to `https://example.invalid/linkN`.
- The site theme name and the student number were replaced too.

## What is real

JSON structure, keys, array lengths, value types, numbers, ids, booleans, timestamps and dates,
settings and configs, Moodle enums and built-in interface strings, the site's function list, and
URL structure (host, paths, components, file areas, query parameters).

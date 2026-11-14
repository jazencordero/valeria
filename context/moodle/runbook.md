# Runbook: the sitting with Valeria

For Jazen. One sitting, about 45 minutes, on her laptop or yours with her at the keyboard.

Ground rules:
- She types her own password on her own screen. You never see it, and you look away while she signs in.
- Keys, QR text and redirect addresses are pasted at hidden prompts. The scripts never print or save them.
- Every command here also runs with `--mock` added, against a pretend Moodle. Rehearse that way the day before.
- MyCourses menu names below are from Moodle's usual wording. They are unverified until the sitting; note the real ones.

Run all commands from the repo folder.

## Part A: get the key

Try these in order. Stop at the first one that works. Tick what worked and what did not.

**1. QR code** - [ ] worked - [ ] did not
1. She opens MyCourses, then her profile, then "View QR code".
2. She scans it with any QR reader on her phone and copies the text it holds.
3. She gets the text to the laptop her own way (for example her notes app), then runs this and pastes it at the hidden prompt:
   ```
   node scripts/moodle/probe.mjs --qr
   ```
The QR code works for a few minutes and only once. If it says "expired or was used already", show a new one.

**2. Launch link on a laptop** - [ ] worked - [ ] did not
1. Run this. It prints an address and a passport. Write the passport down.
   ```
   node scripts/moodle/probe.mjs --launch-url
   ```
2. Open the developer tools in the browser first (Network tab, keep the log on). Then she opens the address and signs in.
3. At the end the browser tries to open a `moodlemobile://token=...` address and fails. Copy it from the console (the whole "Failed to launch" line is fine) or from the Location of the last launch request in the Network tab.
4. Run this with the passport from step 1 in place of PASSPORT, and paste the address at the hidden prompt:
   ```
   node scripts/moodle/probe.mjs --redirect --passport PASSPORT
   ```
It says whether the signature matches. A mismatch is only a warning; note it.

**3. Security keys** - [ ] worked - [ ] did not
1. She opens MyCourses, then Preferences, then "Security keys".
2. She copies the key next to "Moodle mobile web service".
3. Run this, press Enter at the site question, and she pastes the key at the hidden prompt:
   ```
   node scripts/moodle/probe.mjs
   ```

## Part B: the probe (read-only)

Each command in Part A runs the probe right after it gets the key. It only reads. It writes `context/moodle/probe-report.md` and scrubbed answers to `context/moodle/fixtures/`.

Before anything leaves the laptop, open each file in `context/moodle/fixtures/` and the report. Search for her first name, surname, student number and email. If any of them shows up, delete that file and note which call it came from. Commit nothing until this is done.

## Part C: hand-in test

This needs a key she can paste, so use the Security keys key (Part A, 3). If only the QR code or the launch link worked, skip Part C and note it; the hand-in test cannot take those yet.

Pick the assignment together first. It must be one she is handing in anyway, with the real file, or one that says it allows resubmitting. Never a finished or graded one.

```
node scripts/moodle/handin-test.mjs
```

She pastes the key, picks the number, types the assignment's name, then gives the file's path. Nothing is sent until the name matches. It submits for grading only if she types SUBMIT; if unsure, she types anything else.

If step 3 (upload, save, read back) fails:
- Nothing was submitted for grading. Write down the error code it printed.
- She opens the assignment in MyCourses and checks the submission status. If a draft file is there that she does not want, she removes it there ("Remove submission", unverified).
- Do not retry more than once. The report already holds what happened.

## Part D: while the commands run

Ask these eight. Write her answers in `context/user-notes.md` afterwards, facts only.

1. Which Anki decks does she use, how often, phone or laptop? Does she use Hard/Easy or just Again/Good?
2. Does she make her own cards or download shared decks? How long does making them take?
3. Do her exams look like multiple choice, short answer, calculations or essays?
4. Would a 4-of-7-days goal feel motivating or annoying?
5. When in the day does she actually have 5 free minutes?
6. (From the dashboard's Product / Ask Valeria list.)
7. (From the dashboard's Product / Ask Valeria list.)
8. (From the dashboard's Product / Ask Valeria list.)

Questions 1 to 5 come from `context/study-loop.md` ("Ask Valeria"). Fill 6 to 8 from the dashboard list before the sitting.

Four screenshots, taken on her screen with her OK. Crop out her name and photo. Keep them out of the repo.
1. Her MyCourses front page as she sees it (timeline or upcoming deadlines).
2. One assignment page with the submission status box.
3. The grades page of one course.
4. Where she studies now (Anki's home screen or her notes).

## Part E: afterwards

- If she wants, she opens Preferences, then "Security keys", and resets the "Moodle mobile web service" key. That should also end a key from the QR code or launch link; check the list afterwards.
- Nothing was stored: the key lived only in memory while a command ran. The fixtures hold scrubbed answers only.
- Tell her both of these before you leave.

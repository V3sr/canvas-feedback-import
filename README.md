# Canvas Feedback Import

Chrome extension for importing grades and written feedback from a CSV into UBC Canvas. Review each change before importing. Canvas's standard gradebook import accepts scores but does not import submission comments.

The extension runs on `canvas.ubc.ca` using your Canvas session. It sends requests directly to Canvas and has no external server.

## Install (unpacked)

1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Open any page in a Canvas course and click the extension button.

## Workflow

1. **Get template**: tick the assignments you're grading. The list is sorted by due date closest to today, so the lab you're grading is usually at the top.
   - You can limit the template to one section, so each TA gets their own file.
   - "Or download every assignment" is available for anyone who wants everything.
2. Fill in the spreadsheet during the lab.
3. **Upload & import**: choose the file, review the preview, then confirm.

The faculty guide is `format-guide.html`. It opens from "How it works" in the panel.

## CSV format

| Column | Header format | Example |
|---|---|---|
| Student match | `ID` (Canvas user ID), with `SIS User ID` as a fallback | `10492` |
| Name check | `Student` | `Chen, Amy` |
| Grade | `Name (assignment id)` | `Lab 3 (48213)` |
| Feedback | `Name Feedback [assignment id]` | `Lab 3 Feedback [48213]` |

- A blank cell means no change.
- `EX` excuses the student.
- Square brackets on feedback headers keep Canvas's own importer from mistaking them for grade columns.
- The Points Possible row carries `Template downloaded <ISO time> (keep this)`, which is used for newer-grade protection. It's found even if the sheet gets sorted.
- Group-graded assignments get a feedback column only.

Files the tool can read:

- Excel "CSV UTF-8" and plain "CSV" (Windows-1252)
- Excel "Unicode Text" (UTF-16, tab-separated)
- Semicolon CSV from European-locale Excel, including the `sep=` hint line
- Google Sheets CSV

## Safety behaviour

**Nothing posts without review**
- Nothing is written until the user confirms a preview.
- The preview shows every old and new grade and every comment.
- It gives a count per assignment and says who can see each change right away.
- The confirm step names the account the comments will come from.

**Posting to the wrong student**
- Each row's name is checked against its ID.
- A different person blocks the row.
- A slightly different name (preferred name, missing name) starts unticked.
- Three or more mismatches trigger a "rows were sorted without the ID column" warning.

**Sorted columns**
- A grade column sorted on its own is detected, because every changed grade is another student's current grade.
- That assignment's grades are then skipped.

**Newer grades in Canvas**
- If Canvas has a grade newer than the template, it isn't overwritten by default.
- That grade change starts unticked, and any comment still posts.
- The message says whether you or someone else made the newer change (`grader_id`).
- The template time comes from Canvas's clock (the `Date` header), not the laptop's.
- A file without a download time holds back any change that replaces an existing grade.

**Reading grades correctly**
- Late penalties don't cause false changes, because grades use `entered_score`/`entered_grade`.
- Scores keep up to 4 decimals, and the typed value is posted exactly as typed.
- These are all caught instead of being misread:
  - Decimal commas ("7,5")
  - Numbers with spaces in them ("7 5")
  - Scores Excel turned into dates ("8-Oct")
  - Fractions out of the wrong total ("8/20")
  - Excel error text (`#NAME?`)
  - Percent values that look wrong (850, or 0.85)

**Held back for a check (start unticked)**
- Placeholder or number-only feedback.
- A comment whose grade cell had an error.
- Rows sharing a student with another row: all of them are skipped.

**Duplicates and interrupted runs**
- Re-uploading is idempotent: comments already on a submission are skipped, and grades that already match are left alone.
- Before each write the submission is re-read. If it changed since the preview, it's left alone.
- After each write the result is read back to confirm it.
- If a save's outcome is unclear (connection drop), the tool reads instead of retrying, so nothing is posted twice.
- The run stops if the session is lost, after 5 network failures in a row, or after 3 permission errors in a row.

**Blocked outright**
- Anonymous or moderated grading
- Unpublished assignments
- Not-graded assignments
- Closed grading periods
- Concluded courses

**Flagged but allowed**
- Rubric-graded assignments (grades posted here skip the rubric).
- Quizzes and external tools (their own scoring may replace grades set here).
- Group-graded assignments: the grade isn't used, but comments go to each student.

**Accessibility**
- Keyboard focus is managed.
- A persistent live region announces changes to screen readers.
- The tabs use proper tab/tabpanel roles with arrow-key support.
- Motion is reduced when the system asks for it.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest, scoped to `https://canvas.ubc.ca/*` |
| `popup.html/js` | Toolbar button: opens the panel on a course page |
| `content.js`, `panel.css` | Side panel UI (shadow DOM) |
| `lib/csv.js` | Decoding, delimiter detection, parsing, writing |
| `lib/plan.js` | Template building and upload checks (pure, tested) |
| `lib/canvas-api.js` | Canvas REST calls with the session cookie and CSRF token |
| `lib/apply.js` | Re-check, write, and read-back loop |
| `tests/` | `node --test tests/*.test.js` (40 unit tests) and `tests/e2e.js` (Chromium plus mocked Canvas, 13 checks) |

## Check on a real sandbox course before rollout

These are Canvas behaviours the code relies on but that haven't been confirmed on a live course:

- **Assignment fields:**
  - `in_closed_grading_period` is present on assignment objects.
  - `include[]=concluded` returns `concluded` on the course.
- **Grade posting:**
  - `posted_grade: "85%"` on a points assignment converts to points.
  - `entered_score` is returned for teachers.
- **Excused status:** does posting a number on an excused submission remove the excuse, and does `EX` on a group assignment excuse the whole group?
- **Comments on resubmissions:** which attempt the comment attaches to when `comment[attempt]` isn't sent.
- **Stored comment text:** whether Canvas changes line endings or whitespace. If it does, re-uploads would post duplicates.
- **Permission errors:** the 401 messages look as expected for a TA limited to their own sections.
- **Late policy:** whether automatic "missing" zeros set `graded_at` and `grader_id`.

## Changelog

- **0.3.0**
  - Due-date picker with a section filter.
  - Validation: name/ID check, sorted-column detection, newer-grade protection, and precision, date and decimal-comma handling.
  - Group, rubric and quiz handling; per-submission visibility; abort rules.
  - Accessibility and wording pass; SpeedGrader links and a post-grades reminder on the results screen.
- **0.2.0**: all-assignment export (since replaced by the picker).
- **0.1.0**: first working version.

# Changelog

Versions 0.1.0 to 0.3.0 were developed on September 28, 2026 and are documented below. Saved Git history begins at v0.3.1.

## [0.5.0] - 2026-10-05

Better assignment search for big courses (some have over 100 assignments).

- The search box is always shown when a course has more than 5 assignments, and its placeholder says how many there are.
- Search ignores case, accents and punctuation, and every word you type has to match. Numbers match without leading zeros, so "lab 5" finds "Lab 05". It also searches assignment group names.
- An assignment group filter (for example Labs or Quizzes).
- Search results show a match count, with "Tick all N" to select every match at once, and "Clear search".
- Selected assignments appear as removable chips above the list, with a Clear link, so a choice isn't lost when the search changes.
- Each assignment row shows its group name.

## [0.4.0] - 2026-09-28

- Choose what happens when you already left a comment for a student:
  - **Add a new comment** (default): keeps both, for courses with several graders.
  - **Replace your last comment**: edits your own most recent comment. Replacements are counted in the overview and shown with the old text crossed out above the new text.
- **Undo the last import** for each course: restores the previous grades, removes added comments, and puts back the text of replaced ones. Anything changed in Canvas since the import is left alone.
- A **Cancel** button clears a file that's been uploaded but not imported.
- The wording now says "Import" instead of "Post", since "post" in Canvas means making grades visible to students.
- Zero counts are left out of summaries ("Import 1 comment" instead of "1 comment and 0 grades").
- Canvas behaviours confirmed on the sandbox course:
  - Editing and deleting comments.
  - Clearing a grade with an empty value.
  - Entering "85%" on a points assignment.
  - A number replacing an excused status.
  - Line breaks in comments being kept.

## [0.3.2] - 2026-09-28

- Fixed: a real enrolled student whose account is named "Test Student" was skipped without any message. Only Canvas's Student View preview account is skipped now, and the preview says when that happens.
- Moved the Gradebook launcher up so it doesn't cover other on-page buttons.

## [0.3.1] - 2026-09-28

- Added an "Import feedback" button on the Gradebook page.
- Canvas API fields confirmed against a live course (UBC sandbox): `in_closed_grading_period`, `concluded`, `entered_score`, `grader_id`.

## [0.3.0] - 2026-09-28 (not kept as a separate copy)

- **Picking assignments:** the assignment picker lists the closest due dates first, and you can download a template for one section only.
- **Validation:**
  - **Wrong student:** each row's name is checked against its ID.
  - **Sorted columns:** a grade column sorted on its own is detected.
  - **Newer grades:** a grade changed in Canvas after the template was downloaded is protected. The template records its download time in Canvas's server clock.
  - **Reading grades:** decimal commas, grades Excel turned into dates, fractions, percent grades, late penalties (grades are compared as entered, before the penalty), and precision up to 4 decimals.
  - **Excel quirks:** errors like `#NAME?`, semicolon-separated files, UTF-16 files, stray quotes, and text that would run as a spreadsheet formula.
  - **Special assignments:** group-graded, rubric and quiz assignments are handled, and visibility is shown per submission.
  - **Stopping a run:** posting stops if you get signed out, the connection keeps failing, or Canvas keeps refusing permission.
- **Usability:** keyboard focus, screen reader announcements, SpeedGrader links for anything that failed, and a reminder to post grades.

## [0.2.0] - 2026-09-28 (not kept as a separate copy)

- The template export included every assignment (later replaced by the picker in 0.3.0).
- An "By assignment" count was added to the preview.

## [0.1.0] - 2026-09-28 (not kept as a separate copy)

- First working version:
  - Download a CSV template with `Name (id)` grade columns and `Name Feedback [id]` feedback columns.
  - Upload it, preview every change, then import grades and comments together.
  - Each submission is re-checked right before it's written and read back afterwards.
  - Re-uploading the same file is safe.

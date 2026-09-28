/*
 * Applies reviewed changes. For each student/assignment:
 *   1. re-read the submission and stop if it changed since the preview
 *   2. write grade + comment in one request
 *   3. read it back to confirm; if the write's outcome is unclear, read
 *      instead of retrying so nothing gets posted twice
 */
(function (root) {
  'use strict';

  const planLib = (typeof module !== 'undefined' && module.exports) ? require('./plan.js') : root.CFI.plan;

  function gradeMatches(sub, change, assignment) {
    if (!change.grade) return true;
    if (change.grade.excuse) return !!sub.excused;
    if (sub.excused) return false;
    if (change.grade.number != null && assignment.grading_type === 'points') {
      const s = planLib.enteredScore(sub);
      return s != null && Math.abs(Number(s) - change.grade.number) < 0.005;
    }
    if (change.grade.percent != null && assignment.grading_type === 'percent') {
      const cur = parseFloat(String(sub.entered_grade == null ? '' : sub.entered_grade));
      return !isNaN(cur) && Math.abs(cur - change.grade.percent) < 0.005;
    }
    const want = String(change.grade.posted).trim().toLowerCase();
    return [sub.entered_grade, sub.grade].some((g) => g != null && String(g).trim().toLowerCase() === want);
  }

  function hasComment(sub, text) {
    const key = planLib.commentKey(text);
    return (sub.comments || []).some((c) => planLib.commentKey(c) === key);
  }

  async function applyOne(api, courseId, change, assignment) {
    const result = { key: change.key, change, status: 'failed', message: '' };
    let before;
    try {
      before = await api.getSubmission(courseId, change.assignmentId, change.studentId);
    } catch (e) {
      result.message = 'Could not re-check the submission first: ' + e.message;
      result.error = e;
      return result;
    }

    const work = Object.assign({}, change);
    const notes = [];
    if (work.grade && planLib.currentGradeCell(before, assignment) !== work.grade.from) {
      if (gradeMatches(before, work, assignment)) {
        notes.push('grade was already set');
      } else {
        result.status = 'conflict';
        result.message = `The grade in Canvas changed to "${planLib.currentGradeCell(before, assignment) || 'blank'}" after you loaded the preview. Nothing was changed for this student. Reload the file to review it again.`;
        return result;
      }
      work.grade = null;
    }
    if (work.comment && hasComment(before, work.comment)) {
      notes.push('comment was already posted');
      work.comment = null;
    }
    if (!work.grade && !work.comment) {
      result.status = 'skipped';
      result.message = 'Already in Canvas (' + notes.join(', ') + ').';
      return result;
    }

    let writeError = null;
    try {
      await api.updateSubmission(courseId, change.assignmentId, change.studentId, work);
    } catch (e) {
      writeError = e;
      if (!e.uncertain) {
        result.message = e.message;
        result.error = e;
        return result;
      }
    }

    let after;
    try {
      after = await api.getSubmission(courseId, change.assignmentId, change.studentId);
    } catch (e) {
      result.status = 'unverified';
      result.message = 'Saved, but it could not be read back to confirm. Check this student in SpeedGrader.';
      if (writeError) {
        result.message = 'The connection dropped while saving, and it could not be checked afterwards. Check this student in SpeedGrader before trying again.';
        result.error = writeError;
      } else if (e && (e.network || e.sessionLost)) {
        result.error = e;
      }
      return result;
    }
    const gradeOk = gradeMatches(after, work, assignment);
    const commentOk = !work.comment || hasComment(after, work.comment);
    if (gradeOk && commentOk) {
      result.status = 'done';
      result.message = writeError ? 'Saved (confirmed after a connection hiccup).' : (notes.length ? 'Saved; ' + notes.join(', ') + '.' : 'Saved.');
      return result;
    }
    result.status = writeError ? 'failed' : 'unverified';
    const missing = [];
    if (!gradeOk) missing.push(`grade shows "${planLib.currentGradeCell(after, assignment) || 'blank'}"`);
    if (!commentOk) missing.push('comment not found');
    result.message = (writeError ? writeError.message + ' ' : 'Canvas accepted the change but ') + missing.join(' and ') + '.';
    return result;
  }

  /**
   * @param onProgress (doneCount, total, result)
   * @param shouldStop () => boolean, checked before each new item
   */
  async function applyAll(api, courseId, changes, assignmentsById, onProgress, shouldStop, concurrency) {
    const results = [];
    let next = 0;
    let finished = 0;
    let networkStreak = 0;
    let permissionStreak = 0;
    let abortReason = '';
    async function worker() {
      while (next < changes.length) {
        if (abortReason || (shouldStop && shouldStop())) return;
        const c = changes[next++];
        const r = await applyOne(api, courseId, c, assignmentsById[c.assignmentId]);
        results.push(r);
        finished++;
        const e = r.error;
        if (e && e.sessionLost) abortReason = e.message;
        if (e && e.network) { if (++networkStreak >= 5) abortReason = 'Stopped because Canvas stopped responding. Check your connection and upload the file again. Anything already posted will be skipped.'; }
        else if (r.status === 'done' || r.status === 'skipped' || r.status === 'conflict') networkStreak = 0;
        if (e && e.permission) { if (++permissionStreak >= 3) abortReason = 'Stopped because Canvas keeps saying you don\'t have permission. The course may be concluded, the grading period closed, or your role limited to certain sections.'; }
        else if (r.status === 'done') permissionStreak = 0;
        if (onProgress) onProgress(finished, changes.length, r);
      }
    }
    const n = Math.max(1, Math.min(concurrency || 3, changes.length));
    await Promise.all(Array.from({ length: n }, worker));
    const done = new Set(results.map((r) => r.key));
    for (const c of changes) {
      if (!done.has(c.key)) results.push({ key: c.key, change: c, status: 'not_started', message: abortReason ? 'Not tried because the run stopped.' : 'Stopped before this one.' });
    }
    results.abortReason = abortReason;
    return results;
  }

  function safe(v) {
    const csvLib = (typeof module !== 'undefined' && module.exports) ? require('./csv.js') : root.CFI.csv;
    return csvLib.safeText(v);
  }

  function resultsToRows(results) {
    const rows = [['Row', 'Student', 'Student ID', 'Assignment', 'Grade', 'Feedback', 'Result', 'Details']];
    const sorted = results.slice().sort((a, b) => a.change.row - b.change.row || a.change.assignmentName.localeCompare(b.change.assignmentName));
    for (const r of sorted) {
      const c = r.change;
      rows.push([String(c.row), safe(c.studentName), c.studentId, safe(c.assignmentName),
        c.grade ? `${c.grade.from || 'blank'} -> ${c.grade.to}` : '', safe(c.comment || ''), r.status, r.message]);
    }
    return rows;
  }

  const api = { applyOne, applyAll, resultsToRows, gradeMatches };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CFI = root.CFI || {}; root.CFI.apply = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);

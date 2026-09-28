/*
 * Applies reviewed changes. For each student/assignment:
 *   1. re-read the submission and stop if it changed since the preview
 *   2. write the grade and add (or replace) the comment
 *   3. read it back to confirm; if the write's outcome is unclear, read
 *      instead of retrying so nothing gets added twice
 * Each confirmed change also records what's needed to undo it.
 */
(function (root) {
  'use strict';

  const planLib = (typeof module !== 'undefined' && module.exports) ? require('./plan.js') : root.CFI.plan;

  function gradeMatches(sub, change, assignment) {
    if (!change.grade) return true;
    if (change.grade.excuse) return !!sub.excused;
    if (sub.excused) return false;
    if (change.grade.posted == null || change.grade.posted === '') {
      return sub.entered_grade == null && planLib.enteredScore(sub) == null;
    }
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

  function findComment(sub, text) {
    const key = planLib.commentKey(text);
    const list = (sub.comments || []).filter((c) => planLib.commentKey(c) === key);
    return list.length ? list[list.length - 1] : null;
  }
  function hasComment(sub, text) { return !!findComment(sub, text); }
  function commentById(sub, id) {
    return (sub.comments || []).find((c) => c && typeof c === 'object' && String(c.id) === String(id)) || null;
  }

  // The grade as it was, in a form updateSubmission can write back.
  function restoreGrade(before, assignment) {
    if (before.excused) return { excuse: true, to: 'EX' };
    if (assignment.grading_type === 'points') {
      const s = planLib.enteredScore(before);
      return s == null ? { posted: null, to: 'blank' } : { posted: String(s), number: Number(s), to: String(s) };
    }
    if (before.entered_grade == null) return { posted: null, to: 'blank' };
    const pct = assignment.grading_type === 'percent' ? parseFloat(before.entered_grade) : NaN;
    return { posted: String(before.entered_grade), percent: isNaN(pct) ? undefined : pct, to: String(before.entered_grade) };
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
        result.message = `The grade in Canvas changed to "${planLib.currentGradeCell(before, assignment) || 'blank'}" after you loaded the preview. Nothing was changed for this student. Upload the file again to review it.`;
        return result;
      }
      work.grade = null;
    }

    let replaceTarget = null;
    if (work.comment && hasComment(before, work.comment)) {
      notes.push('comment was already there');
      work.comment = null;
    } else if (work.comment && work.replaceComment) {
      const target = commentById(before, work.replaceComment.id);
      if (!target) {
        notes.push('your earlier comment was gone, so this was added as a new one');
      } else if (planLib.commentKey(target) !== planLib.commentKey(work.replaceComment.oldText)) {
        result.status = 'conflict';
        result.message = 'Your earlier comment was edited in Canvas after you loaded the preview, so it was left alone. Upload the file again to review it.';
        return result;
      } else {
        replaceTarget = target;
      }
    }
    if (!work.grade && !work.comment) {
      result.status = 'skipped';
      result.message = 'Already in Canvas (' + notes.join(', ') + ').';
      return result;
    }

    let writeError = null;
    try {
      if (replaceTarget) {
        if (work.grade) await api.updateSubmission(courseId, change.assignmentId, change.studentId, { grade: work.grade });
        await api.editComment(courseId, change.assignmentId, change.studentId, replaceTarget.id, work.comment);
      } else {
        await api.updateSubmission(courseId, change.assignmentId, change.studentId, { grade: work.grade, comment: work.comment });
      }
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
    const commentOk = !work.comment || (replaceTarget
      ? planLib.commentKey(commentById(after, replaceTarget.id) || '') === planLib.commentKey(work.comment)
      : hasComment(after, work.comment));
    if (gradeOk && commentOk) {
      result.status = 'done';
      result.message = writeError ? 'Saved (confirmed after a connection hiccup).' : (notes.length ? 'Saved; ' + notes.join(', ') + '.' : 'Saved.');
      // What undo needs.
      result.undo = { assignmentId: change.assignmentId, studentId: change.studentId };
      if (work.grade) result.undo.grade = { set: work.grade, restore: restoreGrade(before, assignment) };
      if (work.comment) {
        if (replaceTarget) result.undo.comment = { kind: 'restore', id: replaceTarget.id, text: work.comment, oldText: replaceTarget.text };
        else {
          const added = findComment(after, work.comment);
          if (added && added.id) result.undo.comment = { kind: 'delete', id: added.id, text: work.comment };
        }
      }
      return result;
    }
    result.status = writeError ? 'failed' : 'unverified';
    const missing = [];
    if (!gradeOk) missing.push(`grade shows "${planLib.currentGradeCell(after, assignment) || 'blank'}"`);
    if (!commentOk) missing.push('comment not found');
    result.message = (writeError ? writeError.message + ' ' : 'Canvas accepted the change but ') + missing.join(' and ') + '.';
    return result;
  }

  // Runs fn over items with a small worker pool and the same stop rules for
  // import and undo.
  async function runPool(items, fn, onProgress, shouldStop, concurrency) {
    const results = [];
    let next = 0;
    let finished = 0;
    let networkStreak = 0;
    let permissionStreak = 0;
    let abortReason = '';
    async function worker() {
      while (next < items.length) {
        if (abortReason || (shouldStop && shouldStop())) return;
        const item = items[next++];
        const r = await fn(item);
        results.push(r);
        finished++;
        const e = r.error;
        if (e && e.sessionLost) abortReason = e.message;
        if (e && e.network) { if (++networkStreak >= 5) abortReason = 'Stopped because Canvas stopped responding. Check your connection and upload the file again. Anything already imported will be skipped.'; }
        else if (r.status === 'done' || r.status === 'skipped' || r.status === 'conflict') networkStreak = 0;
        if (e && e.permission) { if (++permissionStreak >= 3) abortReason = 'Stopped because Canvas keeps saying you don\'t have permission. The course may be concluded, the grading period closed, or your role limited to certain sections.'; }
        else if (r.status === 'done') permissionStreak = 0;
        if (onProgress) onProgress(finished, items.length, r);
      }
    }
    const n = Math.max(1, Math.min(concurrency || 3, items.length));
    await Promise.all(Array.from({ length: n }, worker));
    return { results, abortReason };
  }

  /**
   * @param onProgress (doneCount, total, result)
   * @param shouldStop () => boolean, checked before each new item
   */
  async function applyAll(api, courseId, changes, assignmentsById, onProgress, shouldStop, concurrency) {
    const { results, abortReason } = await runPool(changes,
      (c) => applyOne(api, courseId, c, assignmentsById[c.assignmentId]), onProgress, shouldStop, concurrency);
    const done = new Set(results.map((r) => r.key));
    for (const c of changes) {
      if (!done.has(c.key)) results.push({ key: c.key, change: c, status: 'not_started', message: abortReason ? 'Not tried because the run stopped.' : 'Stopped before this one.' });
    }
    results.abortReason = abortReason;
    return results;
  }

  // ---------- Undo ----------

  // A compact, storable record of what an import changed.
  function buildUndoRecord(courseId, results, fileName) {
    const items = results.filter((r) => r.status === 'done' && r.undo).map((r) => ({
      key: r.key, row: r.change.row, studentName: r.change.studentName, assignmentName: r.change.assignmentName,
      assignmentId: r.undo.assignmentId, studentId: r.undo.studentId, grade: r.undo.grade || null, comment: r.undo.comment || null,
    }));
    return { courseId: String(courseId), at: new Date().toISOString(), fileName: fileName || '', items };
  }

  async function undoOne(api, courseId, item, assignment) {
    const result = { key: item.key, change: { row: item.row, studentName: item.studentName, assignmentName: item.assignmentName, assignmentId: item.assignmentId, studentId: item.studentId }, status: 'failed', message: '' };
    let cur;
    try {
      cur = await api.getSubmission(courseId, item.assignmentId, item.studentId);
    } catch (e) {
      result.message = 'Could not read the submission: ' + e.message;
      result.error = e;
      return result;
    }
    const notes = [];
    let gradeWork = null;
    if (item.grade) {
      if (gradeMatches(cur, { grade: item.grade.set }, assignment)) gradeWork = item.grade.restore;
      else notes.push(`grade left at ${planLib.currentGradeCell(cur, assignment) || 'blank'} because it was changed after the import`);
    }
    let commentWork = null;
    if (item.comment) {
      const c = commentById(cur, item.comment.id);
      if (!c) notes.push('comment was already gone');
      else if (planLib.commentKey(c) !== planLib.commentKey(item.comment.text)) notes.push('comment left alone because it was edited after the import');
      else commentWork = { comment: item.comment, id: c.id };
    }
    if (!gradeWork && !commentWork) {
      result.status = 'skipped';
      result.message = notes.join('; ') || 'Nothing to undo.';
      return result;
    }
    try {
      if (gradeWork) await api.updateSubmission(courseId, item.assignmentId, item.studentId, { grade: gradeWork });
      if (commentWork) {
        if (commentWork.comment.kind === 'delete') await api.deleteComment(courseId, item.assignmentId, item.studentId, commentWork.id);
        else await api.editComment(courseId, item.assignmentId, item.studentId, commentWork.id, commentWork.comment.oldText);
      }
    } catch (e) {
      result.message = e.message;
      result.error = e;
      return result;
    }
    try {
      const after = await api.getSubmission(courseId, item.assignmentId, item.studentId);
      const gradeOk = !gradeWork || gradeMatches(after, { grade: gradeWork }, assignment);
      let commentOk = true;
      if (commentWork) {
        const c = commentById(after, commentWork.id);
        commentOk = commentWork.comment.kind === 'delete' ? !c : !!c && planLib.commentKey(c) === planLib.commentKey(commentWork.comment.oldText);
      }
      result.status = gradeOk && commentOk ? 'done' : 'unverified';
      const did = [];
      if (gradeWork) did.push(`grade back to ${gradeWork.to}`);
      if (commentWork) did.push(commentWork.comment.kind === 'delete' ? 'comment removed' : 'earlier comment restored');
      result.message = (result.status === 'done' ? 'Undone: ' + did.join(', ') : 'Undo sent but could not be confirmed') + (notes.length ? '; ' + notes.join('; ') : '') + '.';
    } catch (e) {
      result.status = 'unverified';
      result.message = 'Undo sent but could not be read back. Check this student in SpeedGrader.';
    }
    return result;
  }

  async function undoAll(api, courseId, record, assignmentsById, onProgress, shouldStop) {
    const fallback = { grading_type: 'points' };
    const { results, abortReason } = await runPool(record.items,
      (it) => undoOne(api, courseId, it, assignmentsById[it.assignmentId] || fallback), onProgress, shouldStop, 3);
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

  const api = { applyOne, applyAll, resultsToRows, gradeMatches, buildUndoRecord, undoAll, restoreGrade };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CFI = root.CFI || {}; root.CFI.apply = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);

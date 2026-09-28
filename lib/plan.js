/*
 * Pure logic: build the export template and turn an uploaded CSV into a
 * reviewed list of changes. No network calls here, so it is fully testable.
 */
(function (root) {
  'use strict';

  const GRADE_HEADER = /\((\d+)\)\s*$/;
  const FEEDBACK_HEADER = /\[(\d+)\]\s*$/;
  const TEST_STUDENT_NAMES = ['student, test', 'test student'];
  const STAMP_PREFIX = 'Template downloaded ';
  const STAMP_RE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;
  const EXCEL_ERROR = /^#(NAME\?|VALUE!|REF!|DIV\/0!|N\/A|NUM!|NULL!|SPILL!|CALC!|FIELD!|GETTING_DATA)/i;
  const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
  const LOOKS_LIKE_DATE = new RegExp(`^(\\d{1,2}[-\\s](${MONTHS})[a-z]*|(${MONTHS})[a-z]*[-\\s]\\d{1,4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{2,4})$`, 'i');

  function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

  // Comment text as Canvas will store it: unified line endings, no outer space.
  function normalizeComment(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  }
  function commentText(c) { return c && typeof c === 'object' ? c.text : c; }
  function commentKey(text) {
    return normalizeComment(commentText(text)).replace(/\s+/g, ' ').toLowerCase();
  }

  function feedbackHeader(a) { return `${a.name} Feedback [${a.id}]`; }
  function gradeHeader(a) { return `${a.name} (${a.id})`; }
  // Up to 4 decimals, no trailing zeros. Only used for display/template, never
  // to change what gets posted.
  function fmt(n) { return String(Number(Number(n).toFixed(4))); }
  const TOL = 0.005;

  // ---------- names ----------

  function nameTokens(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  }

  // 'match' | 'partial' | 'mismatch' | 'blank'
  function nameMatch(fileName, student) {
    const f = nameTokens(fileName);
    if (!f.length) return 'blank';
    const fs = new Set(f);
    const candidates = [student.sortable_name, student.name, student.short_name].filter(Boolean).map(nameTokens);
    for (const c of candidates) {
      if (c.length === fs.size && c.every((t) => fs.has(t))) return 'match';
    }
    for (const c of candidates) if (c.some((t) => fs.has(t))) return 'partial';
    return 'mismatch';
  }

  // ---------- current values ----------

  function enteredScore(sub) {
    if (!sub) return null;
    return sub.entered_score != null ? sub.entered_score : sub.score;
  }

  // What the template shows for the current grade. Uses the grade as entered,
  // before any late penalty, so re-uploads don't look like changes.
  function currentGradeCell(sub, assignment) {
    if (!sub) return '';
    if (sub.excused) return 'EX';
    if (assignment.grading_type === 'points') {
      const s = enteredScore(sub);
      return s != null ? fmt(s) : '';
    }
    if (sub.entered_grade != null) return String(sub.entered_grade);
    if (sub.grade != null) return String(sub.grade);
    return '';
  }

  function isGroupGraded(a) { return !!(a.group_category_id && !a.grade_group_students_individually); }

  function isSupported(a) {
    return !(a.anonymous_grading || a.moderated_grading || a.published === false ||
      a.grading_type === 'not_graded' || a.in_closed_grading_period);
  }

  // ---------- Export ----------

  function safeName(v) { return /^[=+\-@]/.test(v) ? "'" + v : v; }

  /**
   * @param assignments [{id,name,points_possible,grading_type}]
   * @param students [{id,sortable_name,sis_user_id,login_id,sections:[names]}]
   * @param submissions object keyed `${assignmentId}:${userId}`
   * @param opts {includeCurrentGrades, downloadedAt: Date}
   */
  function buildExportRows(assignments, students, submissions, opts) {
    const o = Object.assign({ includeCurrentGrades: true, downloadedAt: new Date() }, opts);
    const header = ['Student', 'ID', 'SIS User ID', 'SIS Login ID', 'Section'];
    const points = ['Points Possible', '', '', '', STAMP_PREFIX + o.downloadedAt.toISOString() + ' (keep this)'];
    for (const a of assignments) {
      if (!isGroupGraded(a)) {
        header.push(gradeHeader(a));
        points.push(a.grading_type === 'points' && a.points_possible != null ? String(a.points_possible) : '');
      }
      header.push(feedbackHeader(a));
      points.push('');
    }
    const rows = [header, points];
    const sorted = students.slice().sort((x, y) =>
      String(x.sortable_name).localeCompare(String(y.sortable_name)));
    for (const s of sorted) {
      const r = [safeName(s.sortable_name || ''), String(s.id), s.sis_user_id || '', s.login_id || '',
        (s.sections || []).join(', ')];
      for (const a of assignments) {
        const sub = submissions[`${a.id}:${s.id}`];
        if (!isGroupGraded(a)) r.push(o.includeCurrentGrades ? currentGradeCell(sub, a) : '');
        r.push('');
      }
      rows.push(r);
    }
    return rows;
  }

  // ---------- Header analysis ----------

  function analyzeHeader(header, assignmentsById) {
    const out = {
      nameCol: -1, idCol: -1, sisCol: -1,
      gradeCols: [], feedbackCols: [], errors: [], warnings: [],
    };
    const seenGrade = new Map();
    const seenFeedback = new Map();
    header.forEach((raw, index) => {
      const h = String(raw).trim();
      const lower = h.toLowerCase();
      if (lower === 'student' && out.nameCol < 0) { out.nameCol = index; return; }
      if (lower === 'id' && out.idCol < 0) { out.idCol = index; return; }
      if (lower === 'sis user id' && out.sisCol < 0) { out.sisCol = index; return; }

      const fb = h.match(FEEDBACK_HEADER);
      if (fb) {
        const id = fb[1];
        if (!assignmentsById[id]) {
          out.errors.push(`Column "${h}" points to assignment ${id}, which isn't in this course. Check the number in square brackets, or that you're in the right course.`);
          return;
        }
        if (seenFeedback.has(id)) {
          out.errors.push(`There are two feedback columns for "${assignmentsById[id].name}". Keep only one.`);
          return;
        }
        seenFeedback.set(id, index);
        out.feedbackCols.push({ index, assignmentId: id, header: h });
        return;
      }
      const g = h.match(GRADE_HEADER);
      if (g) {
        const id = g[1];
        if (!assignmentsById[id]) {
          out.warnings.push(`Column "${h}" doesn't match an assignment in this course, so it will be ignored.`);
          return;
        }
        if (seenGrade.has(id)) {
          out.errors.push(`There are two grade columns for "${assignmentsById[id].name}". Keep only one.`);
          return;
        }
        seenGrade.set(id, index);
        out.gradeCols.push({ index, assignmentId: id, header: h });
      }
    });
    if (out.idCol < 0 && out.sisCol < 0) {
      out.errors.push('No "ID" or "SIS User ID" column was found, so students can\'t be matched. Start from a downloaded template so these columns are included.');
    }
    if (!out.gradeCols.length && !out.feedbackCols.length) {
      out.errors.push('No grade or feedback columns were found. Grade columns look like "Lab 3 (48213)" and feedback columns look like "Lab 3 Feedback [48213]".');
    }
    return out;
  }

  function findStamp(rows) {
    for (let r = 1; r < rows.length; r++) {
      for (const cell of rows[r]) {
        const s = String(cell);
        if (s.includes(STAMP_PREFIX.trim())) {
          const m = s.match(STAMP_RE);
          if (m) { const d = new Date(m[1]); if (!isNaN(d)) return d; }
        }
      }
    }
    return null;
  }

  // ---------- Grade parsing ----------

  const PASS_FAIL = { complete: 'complete', incomplete: 'incomplete', pass: 'complete', fail: 'incomplete', c: 'complete', i: 'incomplete' };

  function parseNumber(v) {
    if (/^-?\d{1,3}([, ]\d{3})+(\.\d+)?$/.test(v)) return parseFloat(v.replace(/[, ]/g, ''));
    if (/^-?\d+(\.\d+)?$/.test(v) || /^-?\.\d+$/.test(v)) return parseFloat(v);
    return null;
  }

  function parseGrade(value, assignment) {
    const v = String(value).trim();
    if (v === '') return { kind: 'none' };
    if (EXCEL_ERROR.test(v)) return { kind: 'error', message: `The cell shows the Excel error "${v}" instead of a grade.` };
    if (/^ex(cused)?$/i.test(v)) return { kind: 'excuse' };
    const type = assignment.grading_type;
    if (type === 'not_graded') {
      return { kind: 'error', message: 'This assignment is set to "not graded", so it can\'t take a grade.' };
    }
    if (type === 'pass_fail') {
      const pf = PASS_FAIL[v.toLowerCase()];
      if (!pf) return { kind: 'error', message: `"${v}" isn't valid for a complete/incomplete assignment. Use complete or incomplete.` };
      return { kind: 'grade', posted: pf, display: pf };
    }
    if (type === 'points' || type === 'percent') {
      if (/^-?\d+,\d{1,2}$/.test(v)) {
        return { kind: 'error', message: `"${v}" uses a comma for decimals. Use a period, like ${v.replace(',', '.')}.` };
      }
      if (LOOKS_LIKE_DATE.test(v)) {
        return { kind: 'error', message: `"${v}" looks like a date. Excel turns scores like 8/10 into dates, so type just the score (8).` };
      }
      const pp = assignment.points_possible;
      const pct = v.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
      const frac = v.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
      const num = parseNumber(v);
      if (num == null && /^-?[\d.]+(\s+[\d.]+)+$/.test(v)) {
        return { kind: 'error', message: `"${v}" has a space in it. Type the score as one number.` };
      }
      if (type === 'percent') {
        const p = pct ? parseFloat(pct[1]) : num;
        if (p == null) return { kind: 'error', message: `"${v}" isn't a percentage.` };
        const warn = [];
        if (p > 100) warn.push('Above 100%.');
        if (p < 0) warn.push('Negative percentage.');
        if (!pct && p > 0 && p < 1) warn.push(`Did you mean ${fmt(p * 100)}%? This will post ${p}%.`);
        return { kind: 'grade', posted: String(p) + '%', display: String(p) + '%', percent: p, warn };
      }
      if (pct) {
        if (!pp) return { kind: 'error', message: `"${v}" is a percentage, but this assignment has no points possible. Type the score instead.` };
        const n = parseFloat(pct[1]) * pp / 100;
        return { kind: 'grade', posted: `${pct[1]}%`, display: `${fmt(n)} (${pct[1]}%)`, number: n };
      }
      if (frac) {
        const n = parseFloat(frac[1]); const d = parseFloat(frac[2]);
        if (pp != null && Math.abs(d - pp) < 1e-9) return { kind: 'grade', posted: frac[1], display: frac[1], number: n };
        return { kind: 'error', message: `"${v}" is written as a fraction out of ${frac[2]}, but this assignment is out of ${pp}. Type just the score.` };
      }
      if (num == null) return { kind: 'error', message: `"${v}" isn't a number.` };
      return { kind: 'grade', posted: String(num), display: String(num), number: num };
    }
    // letter_grade, gpa_scale: Canvas checks the value against the grading scheme.
    return { kind: 'grade', posted: v, display: v, needsCanvasCheck: true };
  }

  function gradeUnchanged(parsed, sub, assignment) {
    if (!sub) return false;
    if (parsed.kind === 'excuse') return !!sub.excused;
    if (sub.excused) return false;
    if (assignment.grading_type === 'points' && parsed.number != null) {
      const s = enteredScore(sub);
      return s != null && Math.abs(Number(s) - parsed.number) < TOL;
    }
    if (assignment.grading_type === 'percent' && parsed.percent != null) {
      const cur = parseFloat(String(sub.entered_grade == null ? '' : sub.entered_grade));
      return !isNaN(cur) && Math.abs(cur - parsed.percent) < TOL;
    }
    return norm(sub.entered_grade) === norm(parsed.posted) || (sub.entered_grade == null && norm(sub.grade) === norm(parsed.posted));
  }

  function gradeKey(parsed) {
    if (parsed.kind === 'excuse') return 'EX';
    if (parsed.number != null) return fmt(parsed.number);
    if (parsed.percent != null) return fmt(parsed.percent) + '%';
    return norm(parsed.posted);
  }
  function currentKey(sub, a) {
    if (!sub) return '';
    if (sub.excused) return 'EX';
    if (a.grading_type === 'points') { const s = enteredScore(sub); return s == null ? '' : fmt(s); }
    if (a.grading_type === 'percent') { const p = parseFloat(String(sub.entered_grade)); return isNaN(p) ? '' : fmt(p) + '%'; }
    return norm(sub.entered_grade != null ? sub.entered_grade : sub.grade);
  }

  function checkComment(text) {
    if (EXCEL_ERROR.test(text)) {
      return { error: `The feedback cell shows the Excel error "${text.split('\n')[0]}". This happens when feedback starts with - or + or =. Retype it starting with a letter, or put ' in front.` };
    }
    if (/^[\d.,%\s/]+$/.test(text)) return { hold: 'This feedback is only a number. Check that the columns didn\'t shift.' };
    if (/^(-+|\.+|n\/?a|none|x|tbd|\?+)$/i.test(text)) return { hold: 'This looks like a placeholder, not feedback.' };
    return {};
  }

  // ---------- Plan ----------

  /**
   * @param rows parsed CSV rows (first row is the header)
   * @param ctx {assignmentsById, studentsById, studentsBySis, submissions}
   * @param opts {updateGrades}
   */
  function buildPlan(rows, ctx, opts) {
    const o = Object.assign({ updateGrades: true }, opts);
    const plan = {
      changes: [], issues: [],
      counts: { rows: 0, students: 0, alreadyPosted: 0, unchanged: 0, skippedRows: 0 },
      assignments: [], header: null, downloadedAt: null,
    };
    const issue = (level, row, message) => plan.issues.push({ level, row, message });
    if (!rows.length) { issue('error', null, 'The file is empty.'); return plan; }

    const header = analyzeHeader(rows[0], ctx.assignmentsById);
    plan.header = header;
    header.errors.forEach((m) => issue('error', 1, m));
    header.warnings.forEach((m) => issue('warning', 1, m));
    if (header.errors.length) return plan;
    plan.downloadedAt = findStamp(rows);

    const ids = new Set(header.feedbackCols.map((c) => c.assignmentId));
    if (o.updateGrades) header.gradeCols.forEach((c) => ids.add(c.assignmentId));
    const gradeColFor = {}; header.gradeCols.forEach((c) => { gradeColFor[c.assignmentId] = c.index; });
    const fbColFor = {}; header.feedbackCols.forEach((c) => { fbColFor[c.assignmentId] = c.index; });

    // Assignment-level checks.
    const blocked = {};
    const groupGraded = {};
    for (const id of ids) {
      const a = ctx.assignmentsById[id];
      if (a.anonymous_grading || a.moderated_grading) {
        blocked[id] = true;
        issue('error', 1, `"${a.name}" uses anonymous or moderated grading, which this tool doesn't support. Use SpeedGrader for it.`);
      } else if (a.published === false) {
        blocked[id] = true;
        issue('error', 1, `"${a.name}" is unpublished. Canvas won't accept grades or comments until it's published.`);
      } else if (a.in_closed_grading_period) {
        blocked[id] = true;
        issue('error', 1, `"${a.name}" is in a closed grading period, so Canvas won't accept changes to it.`);
      }
      if (blocked[id]) continue;
      if (a.group_category_id && !a.grade_group_students_individually) groupGraded[id] = true;
      if (a.use_rubric_for_grading) {
        issue('warning', 1, `"${a.name}" is graded with a rubric. Grades posted here skip the rubric, and saving the rubric in SpeedGrader later will replace them.`);
      }
      const types = a.submission_types || [];
      if (types.includes('online_quiz') || types.includes('external_tool')) {
        issue('warning', 1, `"${a.name}" is a quiz or external tool. Its own scoring may replace grades set here.`);
      }
    }
    plan.assignments = Array.from(ids).filter((id) => !blocked[id]).map((id) => ctx.assignmentsById[id]);

    const cellOf = (row, i) => (i >= 0 && i < row.length ? row[i] : '');
    const rowHasData = (row) => plan.assignments.some((a) =>
      (fbColFor[a.id] != null && String(cellOf(row, fbColFor[a.id])).trim() !== '') ||
      (o.updateGrades && gradeColFor[a.id] != null && String(cellOf(row, gradeColFor[a.id])).trim() !== ''));

    // First pass: resolve each data row to a student.
    const unknown = [];
    const mismatched = [];
    const resolved = []; // {r, rowNum, student, nameState}
    const rowsByStudent = new Map();
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const rowNum = r + 1;
      const name = String(cellOf(row, header.nameCol)).trim().replace(/^'/, '');
      const idVal = String(cellOf(row, header.idCol)).trim();
      const sisVal = String(cellOf(row, header.sisCol)).trim();

      if (/^points possible/i.test(name)) continue;
      if (!name && !idVal && !sisVal) continue;
      if (!rowHasData(row)) continue;
      plan.counts.rows++;

      let student = null;
      if (/^\d+$/.test(idVal)) student = ctx.studentsById[idVal] || null;
      if (!student && sisVal) student = ctx.studentsBySis[sisVal] || null;
      if (!student) {
        // Canvas's Student View "Test Student" appears in gradebook exports
        // but isn't a real enrollment. Real accounts with that name still match by ID above.
        if (TEST_STUDENT_NAMES.includes(name.toLowerCase())) { plan.counts.skippedRows++; continue; }
        unknown.push({ rowNum, label: name || `ID ${idVal || 'blank'}` });
        continue;
      }

      const nameState = header.nameCol < 0 ? 'nocol' : nameMatch(name, student);
      if (nameState === 'mismatch') {
        mismatched.push(rowNum);
        issue('error', rowNum, `The name "${name}" doesn't match the student with ID ${student.id} (${student.sortable_name}). This row is skipped so feedback can't go to the wrong person.`);
        continue;
      }
      resolved.push({ r, rowNum, student, nameState, name });
      if (!rowsByStudent.has(student.id)) rowsByStudent.set(student.id, []);
      rowsByStudent.get(student.id).push(rowNum);
    }

    if (unknown.length) {
      if (unknown.length <= 5) {
        unknown.forEach((u) => issue('error', u.rowNum, `Couldn't find ${u.label} among this course's active students, so the row is skipped.`));
      } else {
        issue('error', null, `${unknown.length} rows didn't match an active student in this course (rows ${unknown.slice(0, 8).map((u) => u.rowNum).join(', ')}${unknown.length > 8 ? ', …' : ''}). They may have dropped, or be in sections you can't see.`);
      }
    }
    if (mismatched.length >= 3) {
      issue('error', null, 'Several names don\'t match their IDs. The rows may have been sorted without the ID column. Download a fresh template and copy the grades back in.');
    }

    if (header.nameCol < 0 && resolved.length) {
      issue('warning', null, 'There\'s no Student column, so names can\'t be double-checked against IDs.');
    }

    // A grade column sorted on its own keeps each value but moves it to
    // another student. Catch it: the changed cells are just Canvas's current
    // values shuffled around.
    const shuffledGrades = {};
    if (o.updateGrades) {
      for (const a of plan.assignments) {
        if (gradeColFor[a.id] == null) continue;
        const fileKeys = []; const curKeys = [];
        for (const { r, student } of resolved) {
          if (rowsByStudent.get(student.id).length > 1) continue;
          const parsed = parseGrade(cellOf(rows[r], gradeColFor[a.id]), a);
          if (parsed.kind !== 'grade' && parsed.kind !== 'excuse') continue;
          const sub = ctx.submissions[`${a.id}:${student.id}`];
          if (!sub || gradeUnchanged(parsed, sub, a)) continue;
          fileKeys.push(gradeKey(parsed));
          curKeys.push(currentKey(sub, a));
        }
        if (fileKeys.length >= 3 && fileKeys.slice().sort().join('|') === curKeys.slice().sort().join('|')) {
          shuffledGrades[a.id] = true;
          issue('error', null, `The "${a.name}" grades look like they were sorted on their own: every changed grade is another student's current grade. Grades for it are skipped. Sort the whole sheet, or download a fresh template.`);
        }
      }
    }

    // Keep a grade change out of the default selection but still offer it.
    // If the change also carries a comment, the comment stays ticked.
    function holdGrade(change, msg) {
      if (change.comment) {
        const g = Object.assign({}, change, { key: change.key + ':grade', comment: null, replaceComment: null, selected: false, warnings: change.warnings.concat(msg) });
        change.grade = null;
        change.warnings = change.warnings.filter((w) => !/points possible|Negative|grading scheme|excused|late penalty|Above 100|percentage|Did you mean/i.test(w));
        return g;
      }
      change.selected = false;
      change.warnings.push(msg);
      return null;
    }

    for (const item of resolved) {
      const { r, rowNum, student, nameState, name } = item;
      const dupRows = rowsByStudent.get(student.id);
      if (dupRows.length > 1) {
        issue('error', rowNum, `${student.sortable_name} has data on more than one row (rows ${dupRows.join(', ')}). Merge them into one row; none of them are used for now.`);
        continue;
      }
      plan.counts.students++;
      const row = rows[r];

      for (const a of plan.assignments) {
        const sub = ctx.submissions[`${a.id}:${student.id}`];
        const change = {
          key: `${a.id}:${student.id}`, row: rowNum,
          studentId: String(student.id), studentName: student.sortable_name,
          assignmentId: String(a.id), assignmentName: a.name,
          grade: null, comment: null, warnings: [], selected: true,
          visibleNow: !a.post_manually || !!(sub && sub.posted_at),
        };
        let gradeProblem = null;

        if (o.updateGrades && gradeColFor[a.id] != null) {
          const parsed = parseGrade(cellOf(row, gradeColFor[a.id]), a);
          if (shuffledGrades[a.id]) { /* skipped, reported above */ }
          else if (parsed.kind === 'error') gradeProblem = parsed.message;
          else if (parsed.kind !== 'none' && gradeUnchanged(parsed, sub, a)) plan.counts.unchanged++;
          else if (parsed.kind !== 'none') {
            change.grade = {
              from: currentGradeCell(sub, a),
              to: parsed.kind === 'excuse' ? 'EX' : parsed.display,
              posted: parsed.kind === 'excuse' ? null : parsed.posted,
              excuse: parsed.kind === 'excuse',
              number: parsed.number, percent: parsed.percent,
            };
            if (parsed.number != null && a.points_possible != null && parsed.number > a.points_possible) {
              change.warnings.push(`Above the ${a.points_possible} points possible.`);
            }
            if (parsed.number != null && parsed.number < 0) change.warnings.push('Negative score.');
            if (parsed.needsCanvasCheck) change.warnings.push('Canvas will check this against the grading scheme.');
            if (parsed.warn) change.warnings.push(...parsed.warn);
            if (sub && sub.excused && !change.grade.excuse) change.warnings.push('This removes the "excused" status.');
            if (sub && sub.score != null && sub.entered_score != null && Math.abs(sub.score - sub.entered_score) > 1e-9) {
              change.warnings.push('A late penalty applies, so the student will see a lower score than this.');
            }
          }
        }

        if (fbColFor[a.id] != null) {
          const text = normalizeComment(cellOf(row, fbColFor[a.id]));
          if (text) {
            const existing = (sub && sub.comments) || [];
            if (existing.some((c) => commentKey(c) === commentKey(text))) plan.counts.alreadyPosted++;
            else {
              const chk = checkComment(text);
              if (chk.error) { issue('error', rowNum, `${student.sortable_name}, ${a.name}: ${chk.error}`); }
              else {
                change.comment = text;
                if (o.commentMode === 'replace' && ctx.meId) {
                  // Replace the most recent comment this user left; others' comments are never touched.
                  const mine = existing.filter((c) => c && typeof c === 'object' && String(c.author_id) === String(ctx.meId));
                  const last = mine[mine.length - 1];
                  if (last) {
                    change.replaceComment = { id: String(last.id), oldText: commentText(last) };
                    plan.counts.replacing = (plan.counts.replacing || 0) + 1;
                  }
                }
                if (chk.hold) { change.warnings.push(chk.hold); change.selected = false; }
              }
            }
          }
        }

        if (!change.grade && !change.comment && !gradeProblem) continue;
        if (!sub) {
          issue('error', rowNum, `"${a.name}" isn't assigned to ${student.sortable_name}, so nothing can be added for them.`);
          continue;
        }
        if (gradeProblem) {
          issue('error', rowNum, `${student.sortable_name}, ${a.name}: ${gradeProblem}`);
          if (!change.comment) continue;
          change.warnings.push('The grade has a problem, so only the comment would be posted. Ticked off until you check it.');
          change.selected = false;
        }

        if (change.grade && groupGraded[a.id]) {
          change.grade = null;
          groupGraded[a.id] = 'hit';
        }
        let extra = null;
        if (change.grade && plan.downloadedAt && sub.graded_at && new Date(sub.graded_at) > plan.downloadedAt) {
          const now = change.grade.from || 'blank';
          const mine = ctx.meId && sub.grader_id != null && String(sub.grader_id) === String(ctx.meId);
          extra = holdGrade(change, mine
            ? `You changed this grade in Canvas (to ${now}) after downloading the template. Tick to replace it with ${change.grade.to}.`
            : `Someone changed this grade in Canvas (to ${now}) after the template was downloaded. Tick only if you want to overwrite it.`);
          plan.counts.newerInCanvas = (plan.counts.newerInCanvas || 0) + 1;
        } else if (change.grade && !plan.downloadedAt && change.grade.from !== '') {
          extra = holdGrade(change, 'This file has no download time, so it can\'t tell if Canvas has a newer grade. Tick after checking.');
        }
        if (nameState === 'partial' || nameState === 'blank') {
          const note = nameState === 'blank'
            ? 'This row has no name to double-check against the ID.'
            : `The name in the file ("${name}") is a little different from Canvas. Check it's the right student.`;
          for (const c of [change, extra]) if (c) { c.warnings.push(note); c.selected = false; }
        }
        if (change.grade || change.comment) plan.changes.push(change);
        if (extra) plan.changes.push(extra);
      }
    }

    for (const id of Object.keys(groupGraded)) {
      if (groupGraded[id] === 'hit') {
        issue('warning', 1, `"${ctx.assignmentsById[id].name}" is a group assignment graded as a group, so grades from the file aren't used (one grade would change the whole group). Set group grades in SpeedGrader. Comments are still posted to each student.`);
      }
    }
    if (!plan.downloadedAt && plan.changes.some((c) => c.grade && !c.selected)) {
      issue('warning', null, 'This file wasn\'t downloaded from this tool, so it can\'t tell whether its grades are older than Canvas. Grade changes that replace an existing grade are unticked for you to check.');
    }
    return plan;
  }

  function visibilityNote(a) {
    return a.post_manually
      ? 'Students can\'t see new comments until you post grades'
      : 'Students see new comments right away';
  }

  // Assignments ordered for the picker: closest due date to now first (past or
  // future), then undated ones in course order.
  function sortForPicker(assignments, now) {
    const t = (now || new Date()).getTime();
    return assignments.map((a, i) => ({ a, i, d: a.due_at ? Math.abs(new Date(a.due_at).getTime() - t) : Infinity }))
      .sort((x, y) => x.d - y.d || x.i - y.i).map((x) => x.a);
  }

  const api = {
    buildExportRows, analyzeHeader, parseGrade, buildPlan, normalizeComment, commentKey, commentText,
    gradeHeader, feedbackHeader, visibilityNote, currentGradeCell, nameMatch, isSupported, isGroupGraded,
    sortForPicker, findStamp, enteredScore,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CFI = root.CFI || {}; root.CFI.plan = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);

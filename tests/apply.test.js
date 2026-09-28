const test = require('node:test');
const assert = require('node:assert');
const { applyAll, resultsToRows } = require('../lib/apply.js');

const A = { '101': { id: '101', name: 'Lab 1', grading_type: 'points', points_possible: 10 } };

function fakeApi(state, opts = {}) {
  const calls = { put: 0 };
  return {
    calls,
    async getSubmission(c, a, u) {
      if (opts.readFails && calls.put > 0) throw new Error('down');
      return JSON.parse(JSON.stringify(state[`${a}:${u}`]));
    },
    async updateSubmission(c, a, u, work) {
      calls.put++;
      const s = state[`${a}:${u}`];
      if (opts.reject) { const e = new Error('Invalid grade'); e.uncertain = false; throw e; }
      if (work.grade) { s.score = work.grade.number; s.entered_grade = work.grade.posted; }
      if (work.comment) s.comments.push(work.comment);
      if (opts.dropAfterSave) { const e = new Error('Network error'); e.uncertain = true; throw e; }
      return {};
    },
  };
}
const change = (over) => Object.assign({
  key: '101:1', row: 3, studentId: '1', studentName: 'Chen, Amy', assignmentId: '101', assignmentName: 'Lab 1',
  grade: { from: '', to: '8', posted: '8', number: 8 }, comment: 'Good', warnings: [],
}, over);

test('happy path writes and verifies', async () => {
  const state = { '101:1': { score: null, comments: [] } };
  const api = fakeApi(state);
  const [r] = await applyAll(api, 'c', [change()], A);
  assert.strictEqual(r.status, 'done');
  assert.deepStrictEqual(state['101:1'].comments, ['Good']);
});

test('grade changed in Canvas since preview -> conflict, no write', async () => {
  const state = { '101:1': { score: 5, entered_grade: '5', comments: [] } };
  const api = fakeApi(state);
  const [r] = await applyAll(api, 'c', [change()], A);
  assert.strictEqual(r.status, 'conflict');
  assert.strictEqual(api.calls.put, 0);
});

test('comment already there -> skipped, never doubled', async () => {
  const state = { '101:1': { score: 8, entered_grade: '8', comments: ['good'] } };
  const api = fakeApi(state);
  const [r] = await applyAll(api, 'c', [change({ grade: { from: '', to: '8', posted: '8', number: 8 } })], A);
  assert.strictEqual(r.status, 'skipped');
  assert.strictEqual(api.calls.put, 0);
});

test('connection drop after save is reconciled by reading, not retrying', async () => {
  const state = { '101:1': { score: null, comments: [] } };
  const api = fakeApi(state, { dropAfterSave: true });
  const [r] = await applyAll(api, 'c', [change()], A);
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(api.calls.put, 1);
  assert.strictEqual(state['101:1'].comments.length, 1);
});

test('rejected write reports Canvas message', async () => {
  const state = { '101:1': { score: null, comments: [] } };
  const [r] = await applyAll(fakeApi(state, { reject: true }), 'c', [change()], A);
  assert.strictEqual(r.status, 'failed');
  assert.match(r.message, /Invalid grade/);
});

test('stop leaves remaining as not_started; results CSV rows', async () => {
  const state = {}; const changes = [];
  for (let i = 1; i <= 5; i++) { state[`101:${i}`] = { score: null, comments: [] }; changes.push(change({ key: `101:${i}`, studentId: String(i), row: i })); }
  let n = 0;
  const res = await applyAll(fakeApi(state), 'c', changes, A, () => { n++; }, () => n >= 2, 1);
  assert.strictEqual(res.filter((r) => r.status === 'done').length, 2);
  assert.strictEqual(res.filter((r) => r.status === 'not_started').length, 3);
  const rows = resultsToRows(res);
  assert.strictEqual(rows.length, 6);
  assert.strictEqual(rows[1][4], 'blank -> 8');
});

test('session loss stops the whole run', async () => {
  const state = {}; const changes = [];
  for (let i = 1; i <= 6; i++) { state[`101:${i}`] = { score: null, comments: [] }; changes.push(change({ key: `101:${i}`, studentId: String(i), row: i })); }
  const api = fakeApi(state);
  api.updateSubmission = async () => { const e = new Error('Your Canvas session has ended.'); e.sessionLost = true; throw e; };
  const res = await applyAll(api, 'c', changes, A, null, null, 1);
  assert.match(res.abortReason, /session has ended/);
  assert.strictEqual(res.filter((r) => r.status === 'not_started').length, 5);
});

test('late penalty: verify against entered score', async () => {
  const state = { '101:1': { score: null, comments: [] } };
  const api = fakeApi(state);
  const orig = api.updateSubmission;
  api.updateSubmission = async (...args) => { await orig(...args); state['101:1'].entered_score = 8; state['101:1'].score = 7; };
  const [r] = await applyAll(api, 'c', [change()], A);
  assert.strictEqual(r.status, 'done');
});

// ---------- replace + undo ----------
const { buildUndoRecord, undoAll } = require('../lib/apply.js');
const planLib = require('../lib/plan.js');

function richApi(state) {
  let nextId = 100;
  const calls = { put: 0, edit: 0, del: 0 };
  return {
    calls,
    async getSubmission(c, a, u) { return JSON.parse(JSON.stringify(state[`${a}:${u}`])); },
    async updateSubmission(c, a, u, work) {
      calls.put++;
      const s = state[`${a}:${u}`];
      if (work.grade) {
        if (work.grade.excuse) { s.excused = true; s.entered_score = null; s.entered_grade = null; }
        else if (work.grade.posted == null || work.grade.posted === '') { s.excused = false; s.entered_score = null; s.entered_grade = null; s.score = null; }
        else { s.excused = false; s.entered_score = Number(work.grade.posted); s.score = s.entered_score; s.entered_grade = work.grade.posted; }
      }
      if (work.comment) s.comments.push({ id: String(nextId++), author_id: '42', text: work.comment });
    },
    async editComment(c, a, u, id, text) { calls.edit++; state[`${a}:${u}`].comments.find((x) => x.id === id).text = text; },
    async deleteComment(c, a, u, id) { calls.del++; const s = state[`${a}:${u}`]; s.comments = s.comments.filter((x) => x.id !== id); },
  };
}

test('replace mode edits my last comment, leaves the TA comment, and undo restores it', async () => {
  const state = { '101:1': { entered_score: 6, score: 6, entered_grade: '6', comments: [
    { id: '1', author_id: '42', text: 'Old typo feedback' }, { id: '2', author_id: '77', text: 'TA note' }] } };
  const ctx = { assignmentsById: A, studentsById: { '1': { id: '1', sortable_name: 'Chen, Amy' } }, studentsBySis: {}, submissions: JSON.parse(JSON.stringify(state)), meId: '42' };
  const rows = [['Student', 'ID', 'Lab 1 (101)', 'Lab 1 Feedback [101]'], ['Chen, Amy', '1', '8', 'Fixed feedback']];
  A['101'].grading_type = 'points'; A['101'].points_possible = 10;
  const p = planLib.buildPlan(rows, ctx, { commentMode: 'replace' });
  assert.strictEqual(p.counts.replacing, 1);
  assert.strictEqual(p.changes[0].replaceComment.oldText, 'Old typo feedback');
  // plan.js leaves "from" as the current value; the file has no stamp, so the grade was held -> tick it to import.
  const changes = p.changes.map((c) => Object.assign(c, { selected: true }));
  const api = richApi(state);
  const res = await applyAll(api, 'c', changes, A);
  assert.ok(res.every((r) => r.status === 'done'), JSON.stringify(res.map((r) => r.message)));
  assert.deepStrictEqual(state['101:1'].comments.map((c) => c.text), ['Fixed feedback', 'TA note']);
  assert.strictEqual(state['101:1'].entered_score, 8);
  assert.strictEqual(api.calls.edit, 1);

  const record = buildUndoRecord('c', res, 'f.csv');
  const undo = await undoAll(api, 'c', record, A);
  assert.ok(undo.every((r) => r.status === 'done'), JSON.stringify(undo.map((r) => r.message)));
  assert.deepStrictEqual(state['101:1'].comments.map((c) => c.text), ['Old typo feedback', 'TA note']);
  assert.strictEqual(state['101:1'].entered_score, 6);
});

test('undo removes added comments, clears first-time grades, and skips anything changed since', async () => {
  const state = {
    '101:1': { entered_score: null, score: null, entered_grade: null, comments: [] },
    '101:2': { entered_score: null, score: null, entered_grade: null, comments: [] },
  };
  const api = richApi(state);
  const ch = (sid) => ({ key: `101:${sid}`, row: 2, studentId: sid, studentName: 'S' + sid, assignmentId: '101', assignmentName: 'Lab 1',
    grade: { from: '', to: '9', posted: '9', number: 9 }, comment: 'Nice', warnings: [], selected: true });
  const res = await applyAll(api, 'c', [ch('1'), ch('2')], A);
  assert.ok(res.every((r) => r.status === 'done'));
  const record = buildUndoRecord('c', res, 'f.csv');
  assert.strictEqual(record.items.length, 2);
  // Someone regrades student 2 after the import.
  state['101:2'].entered_score = 7; state['101:2'].score = 7; state['101:2'].entered_grade = '7';
  const undo = await undoAll(api, 'c', record, A);
  assert.strictEqual(state['101:1'].entered_score, null);
  assert.deepStrictEqual(state['101:1'].comments, []);
  assert.strictEqual(state['101:2'].entered_score, 7);
  assert.deepStrictEqual(state['101:2'].comments, []);
  assert.match(undo.find((r) => r.key === '101:2').message, /grade left at 7/);
});

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

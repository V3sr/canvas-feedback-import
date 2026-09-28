const test = require('node:test');
const assert = require('node:assert');
const csv = require('../lib/csv.js');
const plan = require('../lib/plan.js');

const A = {
  '101': { id: '101', name: 'Lab 1', points_possible: 10, grading_type: 'points', published: true, post_manually: false },
  '102': { id: '102', name: 'Lab 2, Titration', points_possible: 5, grading_type: 'points', published: true, post_manually: true },
  '103': { id: '103', name: 'Check-off', grading_type: 'pass_fail', published: true },
  '104': { id: '104', name: 'Anon Quiz', grading_type: 'points', points_possible: 5, published: true, anonymous_grading: true },
  '105': { id: '105', name: 'Participation', grading_type: 'percent', points_possible: 10, published: true },
  '106': { id: '106', name: 'Group Poster', grading_type: 'points', points_possible: 20, published: true, group_category_id: '9', grade_group_students_individually: false },
};
const S = {
  '1': { id: '1', sortable_name: 'Chen, Amy', name: 'Amy Chen', sis_user_id: '11111111', login_id: 'achen', sections: ['L1A'] },
  '2': { id: '2', sortable_name: 'Park, Sam', name: 'Sam Park', sis_user_id: '22222222', login_id: 'spark', sections: ['L1A'] },
  '3': { id: '3', sortable_name: 'Élodie, Zoë', name: 'Zoë Élodie', sis_user_id: '33333333', login_id: 'ez', sections: ['L1B'] },
};
function ctx(subs) {
  const bySis = {}; Object.values(S).forEach((s) => { bySis[s.sis_user_id] = s; });
  return { assignmentsById: A, studentsById: S, studentsBySis: bySis, submissions: subs };
}
function baseSubs() {
  const subs = {};
  for (const a of Object.keys(A)) for (const s of ['1', '2', '3']) subs[`${a}:${s}`] = { score: null, entered_score: null, entered_grade: null, comments: [] };
  return subs;
}
const H = (...cols) => ['Student', 'ID', 'SIS User ID', ...cols];
const errors = (p) => p.issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n');

// ---------- CSV ----------

test('csv round trip with commas, quotes, newlines, accents', () => {
  const rows = [['a', 'b,c', 'say "hi"'], ['line1\nline2', ' pad ', 'Zoë']];
  const decoded = csv.decodeBytes(new TextEncoder().encode(csv.serialize(rows)));
  assert.strictEqual(decoded.encoding, 'utf-8');
  assert.deepStrictEqual(csv.parse(decoded.text), rows);
});

test('windows-1252 fallback', () => {
  const d = csv.decodeBytes(new Uint8Array([0x5a, 0x6f, 0xeb, 0x2c, 0x31, 0x0d, 0x0a]));
  assert.strictEqual(d.encoding, 'windows-1252');
  assert.deepStrictEqual(csv.parse(d.text), [['Zoë', '1']]);
});

test('UTF-16 "Unicode Text" (tab separated) is read', () => {
  const text = 'Student\tID\r\nChen, Amy\t1\r\n';
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const d = csv.decodeBytes(new Uint8Array(buf));
  assert.strictEqual(d.encoding, 'utf-16le');
  assert.deepStrictEqual(csv.parse(d.text), [['Student', 'ID'], ['Chen, Amy', '1']]);
});

test('semicolon CSV and sep= line', () => {
  assert.deepStrictEqual(csv.parse('Student;ID;Lab 1 (101)\n"Chen, Amy";1;7\n'), [['Student', 'ID', 'Lab 1 (101)'], ['Chen, Amy', '1', '7']]);
  assert.deepStrictEqual(csv.parse('sep=;\nA;B\n1;2\n'), [['A', 'B'], ['1', '2']]);
});

test('stray quote inside a cell is kept', () => {
  assert.deepStrictEqual(csv.parse('a,Use a 5" ruler,c\nd,e,f\n'), [['a', 'Use a 5" ruler', 'c'], ['d', 'e', 'f']]);
});

test('unterminated quote throws', () => { assert.throws(() => csv.parse('a,"b\n')); });

test('safeText guards formulas', () => {
  assert.strictEqual(csv.safeText('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  assert.strictEqual(csv.safeText('Good'), 'Good');
});

// ---------- export ----------

test('export template layout and stamp', () => {
  const subs = baseSubs();
  subs['101:1'].score = 7; subs['101:1'].entered_score = 8; // late penalty: template shows entered
  subs['101:2'].excused = true;
  const when = new Date('2026-09-28T20:00:00Z');
  const rows = plan.buildExportRows([A['101'], A['102']], Object.values(S), subs, { downloadedAt: when });
  assert.deepStrictEqual(rows[0], ['Student', 'ID', 'SIS User ID', 'SIS Login ID', 'Section',
    'Lab 1 (101)', 'Lab 1 Feedback [101]', 'Lab 2, Titration (102)', 'Lab 2, Titration Feedback [102]']);
  assert.strictEqual(rows[1][0], 'Points Possible');
  assert.strictEqual(plan.findStamp(rows).toISOString(), when.toISOString());
  const byId = (id) => rows.find((r) => r[1] === id);
  assert.strictEqual(byId('1')[5], '8');
  assert.strictEqual(byId('2')[5], 'EX');
});

test('picker sort: closest due first, undated last', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const list = [
    { id: 'a', due_at: '2026-09-01T00:00:00Z' }, { id: 'b', due_at: null },
    { id: 'c', due_at: '2026-10-09T00:00:00Z' }, { id: 'd', due_at: '2026-10-14T00:00:00Z' },
  ];
  assert.deepStrictEqual(plan.sortForPicker(list, now).map((x) => x.id), ['c', 'd', 'a', 'b']);
});

// ---------- plan ----------

test('export -> fill -> plan end to end', () => {
  const subs = baseSubs();
  subs['101:1'].score = 8; subs['101:1'].entered_score = 8;
  const rows = plan.buildExportRows([A['101'], A['102']], Object.values(S), subs);
  const amy = rows.find((r) => r[1] === '1'); const sam = rows.find((r) => r[1] === '2');
  amy[6] = 'Nice work';
  sam[5] = '9.5'; sam[6] = 'Line one\r\nLine two  '; sam[7] = '6';
  const parsed = csv.parse(csv.decodeBytes(new TextEncoder().encode(csv.serialize(rows))).text);
  const p = plan.buildPlan(parsed, ctx(subs), { updateGrades: true });
  assert.strictEqual(errors(p), '');
  assert.strictEqual(p.changes.length, 3);
  assert.ok(p.downloadedAt instanceof Date);
  assert.strictEqual(p.changes.find((c) => c.studentId === '1').comment, 'Nice work');
  const s101 = p.changes.find((c) => c.key === '101:2');
  assert.strictEqual(s101.grade.posted, '9.5');
  assert.strictEqual(s101.comment, 'Line one\nLine two');
  assert.ok(p.changes.find((c) => c.key === '102:2').warnings.some((w) => /Above/.test(w)));
  assert.strictEqual(p.changes.find((c) => c.key === '102:2').visibleNow, false);
  assert.strictEqual(p.counts.unchanged, 1);
});

test('name that does not match the ID blocks the row', () => {
  const rows = [H('Lab 1 (101)', 'Lab 1 Feedback [101]'), ['Park, Sam', '1', '', '9', 'Great work Sam']];
  const p = plan.buildPlan(rows, ctx(baseSubs()), {});
  assert.strictEqual(p.changes.length, 0);
  assert.match(errors(p), /doesn't match the student with ID 1/);
});

test('first-last order and accents still match; partial name is held back', () => {
  const rows = [H('Lab 1 Feedback [101]'), ['Amy Chen', '1', '', 'a'], ['Zoe Elodie', '3', '', 'b'], ['Chen, Amelia', '1', '', 'c']];
  const p = plan.buildPlan(rows.slice(0, 3), ctx(baseSubs()), {});
  assert.strictEqual(p.changes.length, 2);
  assert.ok(p.changes.every((c) => c.selected));
  const p2 = plan.buildPlan([rows[0], rows[3]], ctx(baseSubs()), {});
  assert.strictEqual(p2.changes[0].selected, false);
  assert.match(p2.changes[0].warnings.join(), /little different/);
});

test('shuffled rows raise a summary error', () => {
  const rows = [H('Lab 1 Feedback [101]'), ['Park, Sam', '1', '', 'x'], ['Élodie, Zoë', '2', '', 'y'], ['Chen, Amy', '3', '', 'z']];
  const p = plan.buildPlan(rows, ctx(baseSubs()), {});
  assert.strictEqual(p.changes.length, 0);
  assert.match(errors(p), /sorted without the ID column/);
});

test('grade changed in Canvas after download is held back, comment still ticked', () => {
  const subs = baseSubs();
  subs['101:1'] = { score: 8, entered_score: 8, entered_grade: '8', graded_at: '2026-09-28T21:00:00Z', grader_id: '77', comments: [] };
  subs['101:2'] = { score: 8, entered_score: 8, entered_grade: '8', graded_at: '2026-09-28T21:00:00Z', grader_id: '42', comments: [] };
  const rows = [H('Lab 1 (101)', 'Lab 1 Feedback [101]'),
    ['Park, Sam', '2', '', '9', ''],
    ['Chen, Amy', '1', '', '6', 'Nice'],
    ['Points Possible', '', 'Template downloaded 2026-09-28T20:00:00.000Z (keep this)', '10', '']]; // sorted to the bottom
  const p = plan.buildPlan(rows, Object.assign(ctx(subs), { meId: '42' }), {});
  const amyC = p.changes.find((c) => c.key === '101:1');
  const amyG = p.changes.find((c) => c.key === '101:1:grade');
  assert.strictEqual(amyC.comment, 'Nice'); assert.strictEqual(amyC.grade, null); assert.strictEqual(amyC.selected, true);
  assert.strictEqual(amyG.grade.to, '6'); assert.strictEqual(amyG.selected, false);
  assert.match(amyG.warnings.join(), /Someone changed/);
  const sam = p.changes.find((c) => c.key === '101:2');
  assert.strictEqual(sam.selected, false);
  assert.match(sam.warnings.join(), /You changed this grade/);
});

test('no stamp: replacing an existing grade is held, first grades are not', () => {
  const subs = baseSubs();
  subs['101:1'] = { score: 5, entered_score: 5, entered_grade: '5', comments: [] };
  const p = plan.buildPlan([H('Lab 1 (101)'), ['Chen, Amy', '1', '', '7'], ['Park, Sam', '2', '', '6']], ctx(subs), {});
  assert.deepStrictEqual(p.changes.map((c) => c.selected), [false, true]);
  assert.ok(p.issues.some((i) => /wasn't downloaded from this tool/.test(i.message)));
});

test('a grade column sorted on its own is caught', () => {
  const subs = baseSubs();
  const extra = { '4': 'Diaz, Dee', '5': 'Evans, Eli' };
  const S2 = Object.assign({}, S); Object.entries(extra).forEach(([id, n]) => { S2[id] = { id, sortable_name: n, sections: [] }; });
  const vals = { '1': 9, '2': 7, '3': 5, '4': 3, '5': 1 };
  for (const id of Object.keys(vals)) subs[`101:${id}`] = { score: vals[id], entered_score: vals[id], entered_grade: String(vals[id]), comments: [] };
  const rows = [H('Lab 1 (101)'),
    ['Chen, Amy', '1', '', '1'], ['Park, Sam', '2', '', '3'], ['Élodie, Zoë', '3', '', '5'], ['Diaz, Dee', '4', '', '7'], ['Evans, Eli', '5', '', '9']];
  const p = plan.buildPlan(rows, { assignmentsById: A, studentsById: S2, studentsBySis: {}, submissions: subs }, {});
  assert.strictEqual(p.changes.length, 0);
  assert.match(errors(p), /sorted on their own/);
  // a genuine regrade is not flagged
  rows[1][3] = '8'; rows[2][3] = '6';
  const p2 = plan.buildPlan(rows, { assignmentsById: A, studentsById: S2, studentsBySis: {}, submissions: subs }, {});
  assert.doesNotMatch(errors(p2), /sorted on their own/);
});

test('precision: 4 decimals round trip, no fake change, typed value posted as-is', () => {
  const subs = baseSubs();
  subs['101:1'] = { score: 6.6667, entered_score: 6.6667, entered_grade: '6.6667', comments: [] };
  const rows = plan.buildExportRows([A['101']], [S['1']], subs);
  assert.strictEqual(rows[2][5], '6.6667');
  const p = plan.buildPlan(rows, ctx(subs), {});
  assert.strictEqual(p.changes.length, 0);
  const g = plan.parseGrade('8.333', A['101']);
  assert.strictEqual(g.posted, '8.333');
});

test('spaces, percent sanity, blank and non-Latin names', () => {
  assert.match(plan.parseGrade('7 5', A['101']).message, /space/);
  assert.strictEqual(plan.parseGrade('1 000', { grading_type: 'points', points_possible: 2000 }).number, 1000);
  assert.match(plan.parseGrade('0.85', A['105']).warn.join(), /Did you mean 85%/);
  assert.match(plan.parseGrade('850', A['105']).warn.join(), /Above 100%/);
  assert.strictEqual(plan.nameMatch('王伟', { sortable_name: '王伟' }), 'match');
  assert.strictEqual(plan.nameMatch('李娜', { sortable_name: '王伟' }), 'mismatch');
  const p = plan.buildPlan([H('Lab 1 Feedback [101]'), ['', '1', '', 'hi']], ctx(baseSubs()), {});
  assert.strictEqual(p.changes[0].selected, false);
});

test('group-graded assignment exports feedback column only', () => {
  const rows = plan.buildExportRows([A['106']], [S['1']], {});
  assert.deepStrictEqual(rows[0].slice(5), ['Group Poster Feedback [106]']);
});

test('grade parsing: decimal comma, dates, fractions, percents, thousands', () => {
  const pts = A['101'];
  assert.strictEqual(plan.parseGrade('7,5', pts).kind, 'error');
  assert.match(plan.parseGrade('8-Oct', pts).message, /looks like a date/);
  assert.strictEqual(plan.parseGrade('8/10', pts).number, 8);
  assert.strictEqual(plan.parseGrade('8/20', pts).kind, 'error');
  assert.strictEqual(plan.parseGrade('85%', pts).number, 8.5);
  assert.strictEqual(plan.parseGrade('1,000', { grading_type: 'points', points_possible: 2000 }).number, 1000);
  assert.strictEqual(plan.parseGrade('#NAME?', pts).kind, 'error');
  assert.strictEqual(plan.parseGrade('90', A['105']).posted, '90%');
  assert.strictEqual(plan.parseGrade('90%', A['105']).percent, 90);
  assert.strictEqual(plan.parseGrade('Pass', A['103']).posted, 'complete');
});

test('percent assignment unchanged detection and late penalty entered score', () => {
  const subs = baseSubs();
  subs['105:1'].entered_grade = '90%';
  subs['101:1'] = { score: 7, entered_score: 8, entered_grade: '8', comments: [] };
  const p = plan.buildPlan([H('Participation (105)', 'Lab 1 (101)'), ['Chen, Amy', '1', '', '90', '8']], ctx(subs), {});
  assert.strictEqual(p.changes.length, 0);
  assert.strictEqual(p.counts.unchanged, 2);
});

test('Excel error text in feedback is blocked; placeholder and number-only are held', () => {
  const rows = [H('Lab 1 Feedback [101]', 'Lab 2, Titration Feedback [102]', 'Check-off Feedback [103]'),
    ['Chen, Amy', '1', '', '#NAME?', 'n/a', '7.5']];
  const p = plan.buildPlan(rows, ctx(baseSubs()), {});
  assert.match(errors(p), /Excel error/);
  assert.strictEqual(p.changes.length, 2);
  assert.ok(p.changes.every((c) => !c.selected));
});

test('re-upload skips comments already posted', () => {
  const subs = baseSubs();
  subs['101:1'].comments = ['Nice   work'];
  const p = plan.buildPlan([H('Lab 1 Feedback [101]'), ['Chen, Amy', '1', '', 'nice work']], ctx(subs), {});
  assert.strictEqual(p.changes.length, 0);
  assert.strictEqual(p.counts.alreadyPosted, 1);
});

test('feedback only mode ignores grade columns', () => {
  const p = plan.buildPlan([H('Lab 1 (101)', 'Lab 1 Feedback [101]'), ['Chen, Amy', '1', '', '7', 'hi']], ctx(baseSubs()), { updateGrades: false });
  assert.strictEqual(p.changes.length, 1);
  assert.strictEqual(p.changes[0].grade, null);
});

test('duplicate data rows are all skipped; empty duplicate is ignored', () => {
  const rows = [H('Lab 1 (101)'), ['Park, Sam', '2', '', ''], ['Park, Sam', '2', '', '6'], ['Chen, Amy', '1', '', '5'], ['Chen, Amy', '1', '', '4']];
  const p = plan.buildPlan(rows, ctx(baseSubs()), {});
  assert.deepStrictEqual(p.changes.map((c) => c.studentId), ['2']);
  assert.match(errors(p), /more than one row \(rows 4, 5\)/);
});

test('bad grade with comment: comment kept but unticked', () => {
  const p = plan.buildPlan([H('Check-off (103)', 'Check-off Feedback [103]'), ['Chen, Amy', '1', '', 'maybe', 'Missing goggles']], ctx(baseSubs()), {});
  assert.strictEqual(p.changes.length, 1);
  assert.strictEqual(p.changes[0].selected, false);
  assert.match(errors(p), /"maybe" isn't valid/);
});

test('group-graded assignment: grades dropped, comments kept', () => {
  const p = plan.buildPlan([H('Group Poster (106)', 'Group Poster Feedback [106]'), ['Chen, Amy', '1', '', '18', 'Nice poster']], ctx(baseSubs()), {});
  assert.strictEqual(p.changes.length, 1);
  assert.strictEqual(p.changes[0].grade, null);
  assert.ok(p.issues.some((i) => /graded as a group/.test(i.message)));
});

test('unknown students are summarised when there are many', () => {
  const rows = [H('Lab 1 (101)')];
  for (let i = 0; i < 7; i++) rows.push([`Ghost ${i}`, String(900 + i), '', '5']);
  const p = plan.buildPlan(rows, ctx(baseSubs()), {});
  assert.strictEqual(p.issues.filter((i) => i.level === 'error').length, 1);
  assert.match(errors(p), /7 rows didn't match/);
});

test('assignment-level blocks and unknown feedback id', () => {
  const p = plan.buildPlan([H('Anon Quiz Feedback [104]'), ['Chen, Amy', '1', '', 'x']], ctx(baseSubs()), {});
  assert.match(errors(p), /anonymous or moderated/);
  const bad = plan.buildPlan([H('X Feedback [555]')], ctx(baseSubs()), {});
  assert.match(bad.issues[0].message, /isn't in this course/);
});

test('excused, removing excused, unassigned student', () => {
  const subs = baseSubs();
  subs['101:1'].excused = true;
  subs['101:2'].excused = true;
  delete subs['101:3'];
  const rows = [H('Lab 1 (101)', 'Lab 1 Feedback [101]'),
    ['Chen, Amy', '1', '', 'EX', ''], ['Park, Sam', '2', '', '7', ''], ['Élodie, Zoë', '3', '', '5', 'x']];
  const p = plan.buildPlan(rows, ctx(subs), {});
  assert.strictEqual(p.changes.length, 1);
  assert.match(p.changes[0].warnings.join(), /removes the "excused"/);
  assert.ok(p.issues.some((i) => /isn't assigned/.test(i.message)));
});

test('visibility: manual posting but already posted submission is visible', () => {
  const subs = baseSubs();
  subs['102:1'].posted_at = '2026-09-20T00:00:00Z';
  const p = plan.buildPlan([H('Lab 2, Titration Feedback [102]'), ['Chen, Amy', '1', '', 'hi'], ['Park, Sam', '2', '', 'hi']], ctx(subs), {});
  assert.deepStrictEqual(p.changes.map((c) => c.visibleNow), [true, false]);
});

test('canvas native export header and blank rows are understood', () => {
  const rows = [
    ['Student', 'ID', 'SIS User ID', 'SIS Login ID', 'Section', 'Lab 1 (101)', 'Assignments Current Score'],
    ['    Points Possible', '', '', '', '', '10', '(read only)'],
    ['', '', '', '', '', 'Manual Posting', ''],
    ['Chen, Amy', '1', '11111111', 'achen', 'L1A', '9', '90'],
  ];
  const p = plan.buildPlan(rows, ctx(baseSubs()), {});
  assert.strictEqual(errors(p), '');
  assert.strictEqual(p.changes.length, 1);
  assert.strictEqual(p.changes[0].grade.posted, '9');
});

test('a real enrolled account named "Test Student" is not skipped', () => {
  const S2 = Object.assign({}, S, { '9': { id: '9', sortable_name: 'Student, Test', name: 'Test Student', sections: [] } });
  const subs = baseSubs(); subs['101:9'] = { score: null, comments: [] };
  const rows = [H('Lab 1 Feedback [101]'), ['Student, Test', '9', '', 'hello'], ['Student, Test', '12345', '', 'student view row']];
  const p = plan.buildPlan(rows, { assignmentsById: A, studentsById: S2, studentsBySis: {}, submissions: subs }, {});
  assert.strictEqual(p.changes.length, 1);
  assert.strictEqual(p.changes[0].studentId, '9');
  assert.strictEqual(errors(p), '');
});

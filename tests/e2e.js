// End-to-end: load the unpacked extension in Chromium, mock canvas.ubc.ca,
// export a template, fill it in, upload, post, and re-upload.
// Run: node tests/e2e.js [screenshotDir]
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const csv = require('../lib/csv.js');

const EXT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || path.join(os.tmpdir(), 'cfi-shots');
fs.mkdirSync(SHOTS, { recursive: true });

function extensionId(dir) {
  const hash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return hash.split('').map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

// ---------- mock Canvas ----------
const assignments = [
  { id: '101', position: 1, name: 'Lab 1: Buffers', points_possible: 10, grading_type: 'points', published: true, post_manually: false, due_at: daysFromNow(-1) },
  { id: '102', position: 2, name: 'Lab 2, Titration', points_possible: 5, grading_type: 'points', published: true, post_manually: true, due_at: daysFromNow(6) },
  { id: '103', position: 3, name: 'Safety check-off', grading_type: 'pass_fail', published: true, post_manually: false, due_at: daysFromNow(0) },
  { id: '104', position: 4, name: 'Anonymous quiz', points_possible: 5, grading_type: 'points', published: true, anonymous_grading: true, due_at: daysFromNow(2) },
  { id: '105', position: 5, name: 'Midterm', points_possible: 50, grading_type: 'points', published: true, due_at: daysFromNow(-40), use_rubric_for_grading: true },
];
// A big course: 120 extra quizzes with no due date, in their own group.
for (let i = 1; i <= 120; i++) assignments.push({ id: String(1000 + i), position: 100 + i, name: `Weekly Quiz ${String(i).padStart(2, '0')}`, points_possible: 2, grading_type: 'points', published: true, due_at: null, assignment_group_id: 77 });
assignments.slice(0, 5).forEach((a) => { a.assignment_group_id = a.name.startsWith('Lab') ? 66 : 55; });
function daysFromNow(n) { return new Date(Date.now() + n * 86400000).toISOString(); }
const students = [
  { id: '1', sortable_name: 'Chen, Amy', sis_user_id: '11111111', login_id: 'achen', sec: '9001' },
  { id: '2', sortable_name: 'Park, Sam', sis_user_id: '22222222', login_id: 'spark', sec: '9001' },
  { id: '3', sortable_name: 'Élodie, Zoë', sis_user_id: '33333333', login_id: 'ezoe', sec: '9002' },
];
const subs = {};
for (const a of assignments) for (const s of students) subs[`${a.id}:${s.id}`] = { assignment_id: a.id, user_id: s.id, score: null, entered_score: null, grade: null, entered_grade: null, excused: false, graded_at: null, posted_at: null, submission_comments: [] };
Object.assign(subs['101:1'], { score: 6, entered_score: 6, grade: '6', entered_grade: '6', graded_at: '2026-09-01T00:00:00Z', posted_at: '2026-09-01T00:00:00Z' });
const log = { puts: [], csrfOk: true, edits: 0, deletes: 0 };
let nextCommentId = 1000;

function json(route, body, headers) {
  return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(body) });
}

async function handle(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;
  const q = url.searchParams;
  if (!p.startsWith('/api/')) {
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><title>Course</title></head><body style="font-family:sans-serif;background:#fff"><h1 style="padding:24px">PHRM 100 mock course page</h1></body></html>' });
  }
  if (p === '/api/v1/courses/555') return json(route, { id: '555', name: 'PHRM 100 Mock', course_code: 'PHRM_V 100 101', workflow_state: 'available' });
  if (p === '/api/v1/users/self') return json(route, { id: '42', name: 'Dr. Test Prof' });
  if (p === '/api/v1/courses/555/assignments') return json(route, assignments);
  if (p === '/api/v1/courses/555/assignment_groups') return json(route, [{ id: 66, name: 'Labs' }, { id: 55, name: 'Other' }, { id: 77, name: 'Quizzes' }]);
  if (p === '/api/v1/courses/555/sections') return json(route, [{ id: '9001', name: 'L1A' }, { id: '9002', name: 'L1B' }]);
  if (p === '/api/v1/courses/555/enrollments') {
    const page = q.get('page') || '1';
    const all = students.map((s) => ({ user_id: s.id, course_section_id: s.sec, user: { id: s.id, sortable_name: s.sortable_name, sis_user_id: s.sis_user_id, login_id: s.login_id } }));
    if (page === '1') return json(route, all.slice(0, 2), { Link: '<https://canvas.ubc.ca/api/v1/courses/555/enrollments?page=2&per_page=2>; rel="next"' });
    return json(route, all.slice(2));
  }
  if (p === '/api/v1/courses/555/students/submissions') {
    const ids = q.getAll('assignment_ids[]');
    const withC = q.getAll('include[]').includes('submission_comments');
    return json(route, Object.values(subs).filter((s) => ids.includes(s.assignment_id)).map((s) => withC ? s : Object.assign({}, s, { submission_comments: undefined })));
  }
  const cm = p.match(/^\/api\/v1\/courses\/555\/assignments\/(\d+)\/submissions\/(\d+)\/comments\/(\d+)$/);
  if (cm) {
    const s = subs[`${cm[1]}:${cm[2]}`];
    const c = s.submission_comments.find((x) => x.id === cm[3]);
    if (!c) return route.fulfill({ status: 404, body: '{}' });
    if (req.method() === 'PUT') { log.edits++; c.comment = JSON.parse(req.postData()).comment; }
    if (req.method() === 'DELETE') { log.deletes++; s.submission_comments = s.submission_comments.filter((x) => x !== c); }
    return json(route, c);
  }
  const m = p.match(/^\/api\/v1\/courses\/555\/assignments\/(\d+)\/submissions\/(\d+)$/);
  if (m) {
    const s = subs[`${m[1]}:${m[2]}`];
    if (req.method() === 'PUT') {
      if (req.headers()['x-csrf-token'] !== 'tok+en/=') log.csrfOk = false;
      const body = JSON.parse(req.postData());
      log.puts.push({ key: `${m[1]}:${m[2]}`, body });
      if (body.submission && body.submission.excuse) { s.excused = true; s.score = null; s.grade = null; s.entered_grade = null; }
      if (body.submission && body.submission.posted_grade != null) {
        const g = body.submission.posted_grade;
        s.excused = false;
        if (m[1] === '103') { s.grade = g; s.entered_grade = g; s.score = g === 'complete' ? 1 : 0; }
        else { s.score = Number(g); s.entered_score = Number(g); s.grade = g; s.entered_grade = g; }
        s.graded_at = new Date().toISOString(); s.grader_id = '42';
      }
      if (body.comment && body.comment.text_comment) s.submission_comments.push({ id: String(nextCommentId++), author_id: 42, comment: body.comment.text_comment });
    }
    return json(route, s);
  }
  return route.fulfill({ status: 404, body: '{}' });
}

const checks0 = [];
(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfi-profile-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, channel: 'chromium', acceptDownloads: true, viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await ctx.route('https://canvas.ubc.ca/**', handle);
  await ctx.addCookies([{ name: '_csrf_token', value: encodeURIComponent('tok+en/='), domain: 'canvas.ubc.ca', path: '/', secure: true }]);

  const page = await ctx.newPage();
  page.on('console', (m) => console.log('[console]', m.type(), m.text())); page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('https://canvas.ubc.ca/courses/555/gradebook');
  await page.waitForTimeout(800);

  // Toggle the panel the same way the popup does.
  const id = extensionId(EXT);
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${id}/format-guide.html`);
  await ext.screenshot({ path: path.join(SHOTS, '0-format-guide.png'), fullPage: true });
  await ext.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'https://canvas.ubc.ca/*' });
    await chrome.tabs.sendMessage(t.id, { type: 'cfi-toggle' });
  });
  await ext.close();
  await page.bringToFront();

  await page.getByText('Which assignments are you grading?').waitFor();
  const order = await page.locator('.alist .aname').allInnerTexts();
  console.log('picker order:', JSON.stringify(order));
  if (order[0] !== 'Safety check-off' || order.length !== 8 || order[4] !== 'Midterm') throw new Error('picker not sorted by due date / not truncated: ' + order.join(', '));
  // Search a 125-assignment course.
  await page.locator('#cfi-search').fill('quiz 7');
  const quiz7 = await page.locator('.alist .aname').allInnerTexts();
  checks0.push(['Search "quiz 7" finds Weekly Quiz 07 only', JSON.stringify(quiz7) === JSON.stringify(['Weekly Quiz 07'])]);
  await page.locator('#cfi-search').fill('quiz');
  checks0.push(['Search "quiz" lists 120 weekly quizzes + the anonymous quiz', (await page.locator('.alist .aname').count()) === 121]);
  await page.locator('#cfi-tick-matches').click();
  checks0.push(['Tick all matches selects 120', /Selected \(120\)/.test(await page.locator('.picked-row').innerText())]);
  checks0.push(['Tick all matches returns keyboard focus to search', await page.locator('#cfi-search').evaluate((el) => el.getRootNode().activeElement === el)]);
  await page.screenshot({ path: path.join(SHOTS, '1a-search.png') });
  await page.locator('#cfi-search').fill('lab');
  checks0.push(['Changing search keeps the 120 hidden selections', /Selected \(120\)/.test(await page.locator('.picked-row').innerText())]);
  await page.locator('#cfi-group').selectOption('Labs');
  checks0.push(['Changing group keeps the 120 hidden selections', /Selected \(120\)/.test(await page.locator('.picked-row').innerText())]);
  await page.locator('#cfi-clear-picks').click();
  await page.locator('#cfi-search').fill('');
  await page.locator('#cfi-group').selectOption('Labs');
  const labs = await page.locator('.alist .aname').allInnerTexts();
  checks0.push(['Group filter shows the two labs', labs.length === 2 && labs.every((n) => n.startsWith('Lab'))]);
  await page.locator('#cfi-clear-search').click();
  await page.locator('#cfi-search').fill('lab 2');
  checks0.push(['Search "lab 2" finds Lab 2, Titration', JSON.stringify(await page.locator('.alist .aname').allInnerTexts()) === JSON.stringify(['Lab 2, Titration'])]);
  await page.locator('#cfi-search').fill('');
  if (!(await page.locator('#cfi-a-104').isDisabled())) throw new Error('anonymous should be disabled');
  await page.locator('#cfi-a-103').check();
  await page.locator('#cfi-a-101').check();
  await page.locator('#cfi-a-102').check();
  await page.screenshot({ path: path.join(SHOTS, '1-export.png') });

  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#cfi-download').click()]);
  const tplPath = path.join(SHOTS, 'template.csv');
  await dl.saveAs(tplPath);
  console.log('template name:', dl.suggestedFilename());
  const rows = csv.parse(csv.decodeBytes(fs.readFileSync(tplPath)).text);
  console.log('header:', JSON.stringify(rows[0]));
  const row = (sid) => rows.find((r) => r[1] === sid);
  const col = (h) => rows[0].indexOf(h);
  if (row('1')[col('Lab 1: Buffers (101)')] !== '6') throw new Error('current grade not prefilled');
  if (rows[0][5] !== 'Lab 1: Buffers (101)') throw new Error('columns should follow course order');
  if (!/Template downloaded/.test(rows[1].join(' '))) throw new Error('stamp missing');

  // Fill in like a professor would.
  row('1')[col('Lab 1: Buffers (101)')] = '8.5';
  row('1')[col('Lab 1: Buffers Feedback [101]')] = 'Good technique.\nLabel your flasks next time.';
  row('2')[col('Lab 1: Buffers (101)')] = '9';
  row('2')[col('Lab 2, Titration Feedback [102]')] = 'Endpoint overshot, see me.';
  row('3')[col('Lab 2, Titration (102)')] = 'EX';
  row('3')[col('Safety check-off (103)')] = 'maybe';
  row('3')[col('Safety check-off Feedback [103]')] = 'Missing goggles, redo next week.';
  row('2')[col('Safety check-off (103)')] = 'complete';
  rows.push(['Ghost, Gus', '999', '', '', '', '4', 'hi', '', '', '', '']);
  rows.push(['Wrong, Person', '1', '', '', '', '', 'Should never post', '', '', '', '']);
  const filled = path.join(SHOTS, 'filled.csv');
  fs.writeFileSync(filled, csv.serialize(rows));

  // Meanwhile a TA changes Sam's Lab 1 grade in SpeedGrader.
  await new Promise((r) => setTimeout(r, 50));
  Object.assign(subs['101:2'], { score: 5, entered_score: 5, grade: '5', entered_grade: '5', graded_at: new Date().toISOString(), grader_id: '77' });

  await page.locator('#cfi-tab-import').click();
  await page.locator('#cfi-file').setInputFiles(filled);
  await page.getByRole('heading', { name: 'Review' }).waitFor();
  await page.screenshot({ path: path.join(SHOTS, '2-preview.png') });
  console.log('preview summary:', (await page.locator('.summary').innerText()).replace(/\n/g, ' | '));
  const issues = await page.locator('.issues li').allInnerTexts();
  console.log('issues:', JSON.stringify(issues, null, 1));
  await page.getByRole('heading', { name: 'Review' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, '2b-changes.png') });

  // Zoe's comment is held back because her grade had a problem; tick it on purpose.
  await page.locator('#cfi-c-103-3').check();
  await page.locator('#cfi-post').click();
  await page.screenshot({ path: path.join(SHOTS, '3-confirm.png') });
  const confirmText = await page.locator('.foot.confirm').innerText();
  await page.locator('#cfi-yes').click();
  await page.locator('#cfi-again').waitFor({ timeout: 20000 });
  await page.screenshot({ path: path.join(SHOTS, '4-results.png') });
  console.log('results:', (await page.locator('.content').innerText()).replace(/\n/g, ' | '));

  // Verify Canvas mock state.
  const c = (k) => subs[k].submission_comments.map((x) => x.comment);
  const checks = [...checks0,
    ['Amy grade 8.5', subs['101:1'].score === 8.5],
    ['Amy multiline comment', c('101:1')[0] === 'Good technique.\nLabel your flasks next time.'],
    ['Sam grade changed by TA is protected', subs['101:2'].score === 5],
    ['Wrong-name row never posted', !c('101:1').includes('Should never post')],
    ['Confirm names the commenter', /Dr\. Test Prof/.test(confirmText)],
    ['Sam lab2 comment', c('102:2')[0] === 'Endpoint overshot, see me.'],
    ['Zoe excused', subs['102:3'].excused === true],
    ['Zoe bad pass/fail grade skipped, comment posted after ticking', subs['103:3'].grade == null && c('103:3').length === 1],
    ['Sam complete', subs['103:2'].grade === 'complete'],
    ['CSRF header sent', log.csrfOk],
    ['one PUT per student/assignment', new Set(log.puts.map((x) => x.key)).size === log.puts.length],
  ];

  // Re-upload the same file: nothing should be posted again.
  const putsBefore = log.puts.length;
  await page.locator('#cfi-again').click();
  await page.locator('#cfi-file').setInputFiles(filled);
  await page.locator('.summary .big').waitFor();
  const again = await page.locator('.summary').innerText();
  console.log('re-upload summary:', again.replace(/\n/g, ' | '));
  await page.screenshot({ path: path.join(SHOTS, '5-reupload.png') });
  checks.push(['re-upload has nothing ticked (only the held TA-changed grade)', /Nothing ticked to import/.test(again) && /1 change ticked off/.test(again)]);
  checks.push(['no extra writes', log.puts.length === putsBefore]);

  // Cancel clears the queued upload and shows the last-import box.
  await page.locator('#cfi-clear').click();
  checks.push(['Cancel clears the upload', await page.getByText('Choose your filled-in CSV').isVisible()]);
  checks.push(['Last import box with undo shown', await page.locator('#cfi-undo').isVisible()]);
  await page.screenshot({ path: path.join(SHOTS, '7-cleared.png') });

  // Fix a typo in Amy's feedback and re-import with "Replace your last comment".
  const fixedRows = csv.parse(csv.decodeBytes(fs.readFileSync(filled)).text);
  fixedRows.find((r) => r[1] === '1')[col('Lab 1: Buffers Feedback [101]')] = 'Good technique. Label your flasks next time!';
  const fixed = path.join(SHOTS, 'fixed.csv');
  fs.writeFileSync(fixed, csv.serialize(fixedRows));
  await page.locator('#cfi-mode-replace').check();
  await page.locator('#cfi-file').setInputFiles(fixed);
  await page.getByRole('heading', { name: 'Review' }).waitFor();
  const replSummary = await page.locator('.summary').innerText();
  console.log('replace summary:', replSummary.replace(/\n/g, ' | '));
  checks.push(['Overview flags the replacement', /1 comment will replace your earlier one/.test(replSummary)]);
  await page.getByRole('heading', { name: 'Review' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, '8-replace-preview.png') });
  await page.locator('#cfi-post').click();
  const confirm2 = await page.locator('.foot.confirm').innerText();
  checks.push(['Confirm says Import, not Post', /^Import /.test(confirm2) && /Yes, import/.test(confirm2)]);
  await page.screenshot({ path: path.join(SHOTS, '9-confirm-import.png') });
  await page.locator('#cfi-yes').click();
  await page.locator('#cfi-again').waitFor({ timeout: 20000 });
  checks.push(['Amy comment replaced, not doubled', JSON.stringify(c('101:1')) === JSON.stringify(['Good technique. Label your flasks next time!'])]);
  checks.push(['Edited via the comment endpoint', log.edits === 1]);

  // Undo the replacement from the results screen.
  await page.locator('#cfi-undo').click();
  await page.locator('#cfi-undo-yes').click();
  await page.getByText('Import undone').waitFor({ timeout: 20000 });
  await page.screenshot({ path: path.join(SHOTS, '10-undone.png') });
  checks.push(['Undo restores the earlier comment text', JSON.stringify(c('101:1')) === JSON.stringify(['Good technique.\nLabel your flasks next time.'])]);

  // Narrow viewport layout.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.screenshot({ path: path.join(SHOTS, '6-narrow.png') });

  let failed = 0;
  for (const [name, ok] of checks) { console.log(ok ? 'PASS' : 'FAIL', name); if (!ok) failed++; }
  await ctx.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

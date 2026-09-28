/*
 * Side panel UI injected into canvas.ubc.ca course pages.
 * Built only when the toolbar button is clicked.
 */
(function () {
  'use strict';
  if (window.__cfiLoaded) return;
  window.__cfiLoaded = true;

  const { csv, plan: planLib, canvas, apply } = globalThis.CFI;
  const courseMatch = location.pathname.match(/^\/courses\/(\d+)/);
  if (!courseMatch) return;
  const courseId = courseMatch[1];
  const PICKER_SHORT = 8;

  // ---------- tiny DOM helper ----------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }

  function download(filename, rows) {
    const blob = new Blob([csv.serialize(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function safeName(s) { return String(s || 'course').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60); }
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function plural(n, word, pl) { return `${n} ${n === 1 ? word : (pl || word + 's')}`; }
  function courseLabel() { return state.course ? (state.course.course_code || state.course.name) : 'this course'; }
  function speedGraderUrl(aId, uId) { return `/courses/${courseId}/gradebook/speed_grader?assignment_id=${aId}&student_id=${uId}`; }

  function dueLabel(a) {
    if (!a.due_at) return 'No due date';
    const d = new Date(a.due_at);
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((start(d) - start(new Date())) / 86400000);
    if (days === 0) return 'Due today';
    if (days === -1) return 'Due yesterday';
    if (days === 1) return 'Due tomorrow';
    const opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return 'Due ' + d.toLocaleDateString(undefined, opts);
  }

  // ---------- state ----------
  const state = {
    open: false,
    tab: 'export',
    course: null,
    me: null,
    assignments: null,
    assignmentsById: {},
    students: null,
    sections: [],
    loadError: '',
    alert: '',
    // export
    exportSelection: new Set(),
    exportSearch: '',
    showAllAssignments: false,
    sectionFilter: '',
    includeGrades: true,
    exporting: false,
    // import
    updateGrades: true,
    fileName: '',
    fileNote: '',
    lastFile: null,
    importBusy: false,
    uploadSeq: 0,
    plan: null,
    tickOverrides: new Map(),
    changeFilter: 'all',
    changeSearch: '',
    confirming: false,
    applying: false,
    stopRequested: false,
    progress: { done: 0, total: 0 },
    results: null,
    focusAfterRender: null,
  };

  let host, shadow, body, live, lastFocusOnPage = null;

  function build() {
    host = document.createElement('div');
    host.id = 'cfi-host';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(h('link', { rel: 'stylesheet', href: chrome.runtime.getURL('panel.css') }));
    body = h('aside', { class: 'panel', role: 'dialog', 'aria-labelledby': 'cfi-title' });
    shadow.appendChild(body);
    // Lives outside the re-rendered panel so screen readers hear updates.
    live = h('div', { class: 'visually-hidden', 'aria-live': 'polite', role: 'status' });
    shadow.appendChild(live);
    document.documentElement.appendChild(host);
    shadow.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !state.applying) toggle(false); });
  }

  function toggle(force) {
    const next = force == null ? !state.open : force;
    if (next && !state.open) lastFocusOnPage = document.activeElement;
    state.open = next;
    if (state.open && !host) build();
    if (host) host.style.display = state.open ? '' : 'none';
    if (state.open) {
      state.focusAfterRender = 'cfi-title';
      render();
      if (!state.assignments && !state.loadError) loadBasics();
    } else if (lastFocusOnPage && lastFocusOnPage.focus) {
      lastFocusOnPage.focus();
    }
  }

  // On the Gradebook, where professors already go to import grades, show a
  // small launcher so they don't have to find the toolbar icon.
  function addGradebookLauncher() {
    if (!/^\/courses\/\d+\/gradebook\/?$/.test(location.pathname)) return;
    const lh = document.createElement('div');
    lh.id = 'cfi-launcher-host';
    const ls = lh.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `button{position:fixed;right:20px;bottom:20px;z-index:2147482999;display:flex;align-items:center;gap:8px;
      padding:10px 16px;border-radius:999px;border:0;background:#0b5cad;color:#fff;font:600 14px/1 system-ui,-apple-system,"Segoe UI",sans-serif;
      box-shadow:0 8px 24px rgba(10,20,35,.25);cursor:pointer}button:hover{filter:brightness(1.08)}
      button:focus-visible{outline:3px solid #ffc43d;outline-offset:2px}`;
    const btn = document.createElement('button');
    btn.id = 'cfi-launcher';
    btn.type = 'button';
    btn.textContent = 'Import feedback';
    btn.addEventListener('click', () => toggle(true));
    ls.append(style, btn);
    document.documentElement.appendChild(lh);
  }
  addGradebookLauncher();

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'cfi-toggle') { toggle(); sendResponse({ ok: true }); }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.applying) { e.preventDefault(); e.returnValue = ''; }
  });

  function setAssignments(list) {
    state.assignments = list;
    state.assignmentsById = {};
    list.forEach((a) => { state.assignmentsById[a.id] = a; });
  }

  async function loadBasics() {
    try {
      const [course, assignments, me] = await Promise.all([
        canvas.loadCourse(courseId), canvas.loadAssignments(courseId), canvas.whoAmI().catch(() => null)]);
      state.course = course;
      state.me = me;
      setAssignments(assignments);
      loadStudentsFresh().then(render).catch(() => {});
    } catch (e) {
      state.loadError = e.message;
    }
    render();
  }

  async function loadStudentsFresh() {
    state.students = await canvas.loadStudents(courseId);
    const secs = new Set();
    state.students.forEach((s) => s.sections.forEach((x) => secs.add(x)));
    state.sections = Array.from(secs).sort();
    return state.students;
  }

  function supportIssue(a) {
    if (a.anonymous_grading || a.moderated_grading) return 'Anonymous grading, use SpeedGrader';
    if (a.published === false) return 'Unpublished';
    if (a.grading_type === 'not_graded') return 'Not graded';
    if (a.in_closed_grading_period) return 'Grading period closed';
    return '';
  }
  function cautionChips(a) {
    const out = [];
    if (a.use_rubric_for_grading) out.push('Rubric');
    if (a.group_category_id && !a.grade_group_students_individually) out.push('Group grade');
    if ((a.submission_types || []).some((t) => t === 'online_quiz' || t === 'external_tool')) out.push('Quiz/tool');
    return out;
  }

  // ---------- render ----------
  function render() {
    if (!body) return;
    const active = shadow.activeElement;
    const focusId = state.focusAfterRender || (active && active.id);
    state.focusAfterRender = null;
    const scroller = body.querySelector('.content');
    const scrollTop = scroller ? scroller.scrollTop : 0;
    body.replaceChildren(...[
      header(),
      tabs(),
      h('div', { class: 'content', id: 'cfi-panel-' + state.tab, role: 'tabpanel', 'aria-labelledby': 'cfi-tab-' + state.tab },
        state.tab === 'export' ? exportView() : importView()),
      footerView(),
    ].filter(Boolean));
    const newScroller = body.querySelector('.content');
    if (newScroller) newScroller.scrollTop = scrollTop;
    if (focusId) {
      const el = shadow.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: focusId === (active && active.id) });
        if (el.setSelectionRange && el.type === 'search') el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  }

  function say(text) {
    if (!live) return;
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 150);
  }

  function header() {
    const title = state.course ? courseLabel() : 'Loading course…';
    return h('header', { class: 'head' },
      h('div', { class: 'titles' },
        h('div', { class: 'eyebrow' }, 'Feedback Import'),
        h('h2', { class: 'course', id: 'cfi-title', tabindex: '-1', title: state.course ? state.course.name : '' }, title)),
      h('a', { class: 'help', href: chrome.runtime.getURL('format-guide.html'), target: '_blank', rel: 'noopener' }, 'How it works'),
      h('button', { class: 'icon', id: 'cfi-close', 'aria-label': 'Close panel', disabled: state.applying, onclick: () => toggle(false) }, '×'));
  }

  function tabs() {
    const ids = ['export', 'import'];
    const labels = { export: '1  Get template', import: '2  Upload & post' };
    const onKey = (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const next = ids[(ids.indexOf(state.tab) + 1) % 2];
      state.tab = next; state.focusAfterRender = 'cfi-tab-' + next; render();
    };
    return h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Steps' }, ids.map((id) => h('button', {
      class: 'tab' + (state.tab === id ? ' on' : ''), role: 'tab', id: 'cfi-tab-' + id,
      'aria-selected': String(state.tab === id), 'aria-controls': 'cfi-panel-' + id,
      tabindex: state.tab === id ? '0' : '-1', disabled: state.applying, onkeydown: onKey,
      onclick: () => { state.tab = id; state.focusAfterRender = 'cfi-tab-' + id; render(); },
    }, labels[id])));
  }

  function isConcluded() { return !!(state.course && (state.course.concluded || state.course.workflow_state === 'completed')); }

  function concludedBanner() {
    if (isConcluded()) {
      return errorBox('This course is concluded, so Canvas won\'t accept new grades or comments here.');
    }
    return null;
  }

  // ---------- export view ----------
  function exportView() {
    if (state.loadError) return errorBox(state.loadError);
    if (!state.assignments) return h('p', { class: 'muted pad' }, 'Loading assignments…');

    const sorted = planLib.sortForPicker(state.assignments);
    const q = state.exportSearch.trim().toLowerCase();
    let list = q ? sorted.filter((a) => a.name.toLowerCase().includes(q)) : sorted;
    const truncated = !q && !state.showAllAssignments && list.length > PICKER_SHORT;
    if (truncated) list = list.slice(0, PICKER_SHORT);
    const count = state.exportSelection.size;
    const supportedCount = state.assignments.filter((a) => !supportIssue(a)).length;

    return [
      concludedBanner(),
      state.alert ? errorBox(state.alert) : null,
      h('h3', { class: 'q' }, 'Which assignments are you grading?'),
      h('p', { class: 'muted small' }, 'Closest due dates are at the top. Pick one or more.'),
      state.assignments.length > PICKER_SHORT ? h('input', {
        id: 'cfi-search', class: 'search', type: 'search', placeholder: 'Search assignments', 'aria-label': 'Search assignments',
        value: state.exportSearch, oninput: (e) => { state.exportSearch = e.target.value; render(); } }) : null,
      h('ul', { class: 'alist', 'aria-label': 'Assignments' }, list.length ? list.map((a) => {
        const issue = supportIssue(a);
        const id = 'cfi-a-' + a.id;
        return h('li', { class: (issue ? 'off' : '') + (state.exportSelection.has(a.id) ? ' picked' : '') },
          h('input', { type: 'checkbox', id, disabled: !!issue, checked: state.exportSelection.has(a.id),
            onchange: (e) => { e.target.checked ? state.exportSelection.add(a.id) : state.exportSelection.delete(a.id); state.focusAfterRender = id; render(); } }),
          h('label', { for: id },
            h('span', { class: 'aname' }, a.name),
            h('span', { class: 'ameta' },
              h('span', null, dueLabel(a)),
              h('span', null, a.grading_type === 'points' ? `${a.points_possible ?? 0} pts` : a.grading_type === 'pass_fail' ? 'Complete/incomplete' : a.grading_type.replace(/_/g, ' ')),
              issue ? h('span', { class: 'chip bad' }, issue) : cautionChips(a).map((c) => h('span', { class: 'chip warn' }, c)))));
      }) : h('li', { class: 'muted' }, 'No assignments match.')),
      truncated ? h('button', { class: 'link', id: 'cfi-showall', onclick: () => { state.showAllAssignments = true; state.focusAfterRender = 'cfi-showall-less'; render(); } },
        `Show all ${state.assignments.length} assignments`) : null,
      !truncated && !q && state.showAllAssignments && state.assignments.length > PICKER_SHORT
        ? h('button', { class: 'link', id: 'cfi-showall-less', onclick: () => { state.showAllAssignments = false; render(); } }, 'Show fewer') : null,

      h('div', { class: 'opts' },
        state.sections.length > 1 ? h('label', { class: 'field' }, 'Students',
          h('select', { id: 'cfi-section', onchange: (e) => { state.sectionFilter = e.target.value; } },
            h('option', { value: '' }, 'All sections'),
            state.sections.map((s) => h('option', { value: s, selected: state.sectionFilter === s ? 'selected' : null }, s)))) : null,
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', id: 'cfi-prefill', checked: state.includeGrades, onchange: (e) => { state.includeGrades = e.target.checked; } }),
          'Fill in grades already in Canvas')),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', id: 'cfi-download', disabled: !count || state.exporting, onclick: () => doExport(false) },
          state.exporting ? 'Building…' : count ? `Download template (${plural(count, 'assignment')})` : 'Pick an assignment above')),
      h('p', { class: 'muted small center' },
        h('button', { class: 'link', id: 'cfi-download-all', disabled: state.exporting || !supportedCount, onclick: () => doExport(true) },
          `Or download every assignment (${supportedCount})`)),
      h('p', { class: 'muted small tip' }, 'Download a fresh template each time you grade, so the grades in it are current.'),
    ];
  }

  async function doExport(all) {
    state.alert = '';
    state.exporting = true; render();
    try {
      if (!state.students) await loadStudentsFresh();
      const selected = state.assignments.filter((a) => !supportIssue(a) && (all || state.exportSelection.has(a.id)));
      // Template columns follow course order, which matches the gradebook.
      selected.sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
      const students = state.sectionFilter ? state.students.filter((s) => s.sections.includes(state.sectionFilter)) : state.students;
      // Always read submissions: it's also what gives us Canvas's clock for the stamp.
      const subs = await canvas.loadSubmissions(courseId, selected.map((a) => a.id), false);
      const rows = planLib.buildExportRows(selected, students, subs, { includeCurrentGrades: state.includeGrades, downloadedAt: canvas.serverNow() });
      const label = all ? 'all_assignments' : selected.length === 1 ? selected[0].name : `${selected.length}_assignments`;
      const sec = state.sectionFilter ? '_' + safeName(state.sectionFilter) : '';
      download(`${safeName(courseLabel())}_${safeName(label)}${sec}_${today()}.csv`, rows);
      say('Template downloaded.');
    } catch (e) {
      state.alert = e.message;
    }
    state.exporting = false; render();
  }

  // ---------- import view ----------
  function importView() {
    if (state.loadError) return errorBox(state.loadError);
    if (!state.assignments) return h('p', { class: 'muted pad' }, 'Loading assignments…');
    if (state.results) return resultsView();
    if (state.applying) return progressView();

    const parts = [concludedBanner()];
    if (state.alert) parts.push(errorBox(state.alert));
    parts.push(
      dropZone(),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', id: 'cfi-update-grades', checked: state.updateGrades, disabled: state.importBusy,
          onchange: (e) => { state.updateGrades = e.target.checked; if (state.lastFile) readFile(state.lastFile, true); } }),
        'Also update grades from the file'),
      h('p', { class: 'muted small indent' }, state.updateGrades
        ? 'Blank grade cells are left alone. A grade only changes when it\'s different from Canvas.'
        : 'Only feedback will be posted. No grades will change.'),
    );
    if (state.importBusy) parts.push(h('p', { class: 'muted pad', role: 'status' }, 'Checking the file against Canvas…'));
    if (state.plan && !state.importBusy) parts.push(planView());
    return parts;
  }

  function dropZone() {
    const busy = state.importBusy;
    const input = h('input', { type: 'file', accept: '.csv,.txt,.tsv,text/csv', id: 'cfi-file', class: 'visually-hidden', disabled: busy,
      onchange: (e) => { const f = e.target.files[0]; if (f) readFile(f); e.target.value = ''; } });
    const zone = h('label', { class: 'drop' + (busy ? ' busy' : ''), for: 'cfi-file',
      ondragover: (e) => { e.preventDefault(); if (!busy) zone.classList.add('over'); },
      ondragleave: () => zone.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); zone.classList.remove('over'); if (busy) return; const f = e.dataTransfer.files[0]; if (f) readFile(f); } },
      h('strong', null, state.fileName ? state.fileName : 'Choose your filled-in CSV'),
      h('span', { class: 'muted small' }, state.fileName ? 'Choose or drop another file to replace it' : 'or drop it here'));
    return [input, zone, state.fileNote ? h('p', { class: 'note' }, state.fileNote) : null];
  }

  async function readFile(file, keepTicks) {
    const seq = ++state.uploadSeq;
    state.alert = '';
    state.lastFile = file;
    state.fileName = file.name;
    state.fileNote = '';
    state.plan = null;
    state.confirming = false;
    if (!keepTicks) state.tickOverrides = new Map();
    if (/\.(xlsx|xls|numbers|ods)$/i.test(file.name)) {
      state.alert = 'That\'s a spreadsheet file, not a CSV. In Excel use File > Save As > "CSV UTF-8 (Comma delimited)". In Google Sheets use File > Download > CSV.';
      render(); return;
    }
    if (!/\.(csv|txt|tsv)$/i.test(file.name)) {
      state.alert = 'Please choose a .csv file.';
      render(); return;
    }
    state.importBusy = true; render();
    try {
      const { text, encoding } = csv.decodeBytes(await file.arrayBuffer());
      if (encoding === 'windows-1252') state.fileNote = 'This file was saved in an older Excel format. Accented names were converted, but check them in the preview. Saving as "CSV UTF-8" avoids this.';
      const rows = csv.parse(text);
      // Fresh data every upload, so publishing or posting changes are picked up.
      const [assignments, students] = await Promise.all([canvas.loadAssignments(courseId), loadStudentsFresh()]);
      if (seq !== state.uploadSeq) return;
      setAssignments(assignments);
      const header = planLib.analyzeHeader(rows[0] || [], state.assignmentsById);
      const ids = new Set(header.feedbackCols.map((c) => c.assignmentId));
      if (state.updateGrades) header.gradeCols.forEach((c) => ids.add(c.assignmentId));
      const subs = ids.size ? await canvas.loadSubmissions(courseId, Array.from(ids), true) : {};
      if (seq !== state.uploadSeq) return;
      const byId = {}; const bySis = {};
      students.forEach((s) => { byId[s.id] = s; if (s.sis_user_id) bySis[s.sis_user_id] = s; });
      const plan = planLib.buildPlan(rows, {
        assignmentsById: state.assignmentsById, studentsById: byId, studentsBySis: bySis, submissions: subs,
        meId: state.me ? String(state.me.id) : null,
      }, { updateGrades: state.updateGrades });
      plan.changes.forEach((c) => { if (state.tickOverrides.has(c.key)) c.selected = state.tickOverrides.get(c.key); });
      state.plan = plan;
      state.changeFilter = 'all'; state.changeSearch = '';
      const errs = plan.issues.filter((i) => i.level === 'error').length;
      state.importBusy = false; render();
      say(`${plural(plan.changes.length, 'change')} found${errs ? `, ${plural(errs, 'problem')} to look at` : ''}.`);
      return;
    } catch (e) {
      if (seq !== state.uploadSeq) return;
      state.alert = e.message;
    }
    state.importBusy = false; render();
  }

  function planView() {
    const p = state.plan;
    const errors = p.issues.filter((i) => i.level === 'error');
    const warnings = p.issues.filter((i) => i.level === 'warning');
    const selected = p.changes.filter((c) => c.selected);
    const nComments = selected.filter((c) => c.comment).length;
    const nGrades = selected.filter((c) => c.grade).length;
    const heldBack = p.changes.length - selected.length;
    const out = [];

    const facts = [];
    if (heldBack) facts.push(`${plural(heldBack, 'change')} ticked off for you to check`);
    if (p.counts.alreadyPosted) facts.push(`${plural(p.counts.alreadyPosted, 'comment')} already in Canvas, skipped`);
    if (p.counts.unchanged) facts.push(`${plural(p.counts.unchanged, 'grade')} already match Canvas`);
    if (p.downloadedAt) facts.push(`Template downloaded ${p.downloadedAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`);

    out.push(h('section', { class: 'summary' },
      h('div', { class: 'big' }, !p.changes.length ? 'Nothing new to post' : !selected.length ? 'Nothing ticked to post' : `${plural(nComments, 'comment')}, ${plural(nGrades, 'grade')}`),
      selected.length ? h('div', { class: 'muted' }, `ready to post for ${plural(new Set(selected.map((c) => c.studentId)).size, 'student')}`) : null,
      facts.length ? h('ul', { class: 'facts' }, facts.map((f) => h('li', null, f))) : null));

    const touched = p.assignments.map((a) => {
      const cs = selected.filter((c) => c.assignmentId === a.id);
      return { a, grades: cs.filter((c) => c.grade).length, comments: cs.filter((c) => c.comment).length, visible: cs.filter((c) => c.visibleNow).length, n: cs.length };
    }).filter((x) => x.n);
    if (touched.length) {
      out.push(h('section', { class: 'box' },
        h('h3', null, 'By assignment'),
        h('ul', { class: 'vis' }, touched.map(({ a, grades, comments, visible, n }) => h('li', null,
          h('span', { class: 'aname' }, a.name,
            h('span', { class: 'counts' }, [grades ? plural(grades, 'grade') : '', comments ? plural(comments, 'comment') : ''].filter(Boolean).join(' · '))),
          h('span', { class: 'chip' + (visible ? ' warn' : '') },
            visible === 0 ? 'Hidden until you post grades' : visible === n ? 'Students see it right away' : `${visible} of ${n} seen right away`))))));
    }

    if (errors.length || warnings.length) {
      out.push(h('section', { class: 'box issues' },
        h('h3', null, errors.length ? `${plural(errors.length, 'problem')} to look at` : 'Notes'),
        errors.length ? h('p', { class: 'muted small' }, p.changes.length
          ? 'These are skipped. Fix them in the file and upload it again (anything already posted is skipped), or post the rest now.'
          : 'Fix these in the file and upload it again.') : null,
        h('ul', null, [...errors, ...warnings].sort((x, y) => (x.level === y.level ? 0 : x.level === 'error' ? -1 : 1) || (x.row || 0) - (y.row || 0)).map((i) => h('li', { class: i.level },
          i.row && i.row > 1 ? h('span', { class: 'row' }, `Row ${i.row}`) : null, i.message)))));
    }

    if (p.changes.length) out.push(changesList());
    return out;
  }

  function setTick(c, v) { c.selected = v; state.tickOverrides.set(c.key, v); }

  function changesList() {
    const p = state.plan;
    const q = state.changeSearch.trim().toLowerCase();
    const shown = p.changes.filter((c) => {
      if (state.changeFilter === 'grades' && !c.grade) return false;
      if (state.changeFilter === 'comments' && !c.comment) return false;
      if (state.changeFilter === 'check' && !c.warnings.length && c.selected) return false;
      if (q && !(c.studentName.toLowerCase().includes(q) || c.assignmentName.toLowerCase().includes(q) || c.studentId === q)) return false;
      return true;
    });
    // "Tick shown" leaves flagged changes alone unless you're looking at them on purpose.
    const setAll = (v, id) => {
      shown.forEach((c) => { if (!v || !c.warnings.length || state.changeFilter === 'check') setTick(c, v); });
      state.confirming = false; state.focusAfterRender = id; render();
    };
    const needCheck = p.changes.filter((c) => c.warnings.length || !c.selected).length;
    return h('section', { class: 'box' },
      h('h3', null, 'Review'),
      h('div', { class: 'toolbar' },
        h('input', { id: 'cfi-csearch', class: 'search', type: 'search', placeholder: 'Search students', 'aria-label': 'Search students', value: state.changeSearch,
          oninput: (e) => { state.changeSearch = e.target.value; render(); } }),
        h('select', { id: 'cfi-cfilter', 'aria-label': 'Show', onchange: (e) => { state.changeFilter = e.target.value; state.focusAfterRender = 'cfi-cfilter'; render(); } },
          [['all', 'Everything'], ['comments', 'Comments'], ['grades', 'Grade changes'], ['check', `Needs a look (${needCheck})`]].map(([v, l]) =>
            h('option', { value: v, selected: state.changeFilter === v ? 'selected' : null }, l)))),
      h('div', { class: 'selbar' },
        h('span', { class: 'muted small' }, `Showing ${shown.length} of ${p.changes.length}`),
        h('button', { class: 'link', id: 'cfi-tick-all', onclick: () => setAll(true, 'cfi-tick-all') }, 'Tick shown'),
        h('button', { class: 'link', id: 'cfi-untick-all', onclick: () => setAll(false, 'cfi-untick-all') }, 'Untick shown')),
      h('ul', { class: 'changes' }, shown.slice(0, 400).map((c) => {
        const id = 'cfi-c-' + c.key.replace(/:/g, '-');
        return h('li', { class: (c.selected ? '' : 'unsel') + (c.warnings.length ? ' flagged' : '') },
          h('input', { type: 'checkbox', id, checked: c.selected, 'aria-describedby': id + '-d',
            onchange: (e) => { setTick(c, e.target.checked); state.confirming = false; state.focusAfterRender = id; render(); } }),
          h('div', { class: 'cbody' },
            h('label', { for: id, class: 'who' }, h('strong', null, c.studentName), h('span', { class: 'muted small' }, ` · ${c.assignmentName}`)),
            h('div', { id: id + '-d' },
              c.grade ? h('div', { class: 'grade' }, 'Grade ', h('s', null, c.grade.from || 'blank'), ' → ', h('strong', null, c.grade.to)) : null,
              c.comment ? h('div', { class: 'comment' }, c.comment) : null,
              c.warnings.map((w) => h('div', { class: 'warnline' }, w)),
              h('div', { class: 'rowref' }, `Row ${c.row}`, c.visibleNow ? ' · seen right away' : ''))));
      })),
      shown.length > 400 ? h('p', { class: 'muted small' }, 'Showing the first 400. Search to find others. Everything ticked is still posted.') : null);
  }

  function footerView() {
    if (state.tab !== 'import' || !state.plan || state.importBusy || state.applying || state.results || !state.plan.changes.length) return null;
    if (isConcluded()) return null;
    const selected = state.plan.changes.filter((c) => c.selected);
    const nComments = selected.filter((c) => c.comment).length;
    const nGrades = selected.filter((c) => c.grade).length;
    if (!selected.length) return h('footer', { class: 'foot' }, h('button', { class: 'primary', disabled: true }, 'Nothing ticked'));
    if (!state.confirming) {
      return h('footer', { class: 'foot' },
        h('button', { class: 'primary', id: 'cfi-post', onclick: () => { state.confirming = true; state.focusAfterRender = 'cfi-confirm-title'; render(); } },
          `Post to Canvas…`));
    }
    const visibleNow = selected.filter((c) => c.visibleNow).length;
    const who = state.me && state.me.name ? state.me.name : 'you';
    return h('footer', { class: 'foot confirm', role: 'alertdialog', 'aria-labelledby': 'cfi-confirm-title', 'aria-describedby': 'cfi-confirm-desc' },
      h('p', { id: 'cfi-confirm-title', tabindex: '-1' }, h('strong', null, `Post ${plural(nComments, 'comment')} and ${plural(nGrades, 'grade')} to ${courseLabel()}?`)),
      h('div', { id: 'cfi-confirm-desc' },
        visibleNow ? h('p', { class: 'small' }, `${visibleNow === selected.length ? 'All of these are' : `${visibleNow} of these are`} visible to students right away, and students may get a notification.`)
          : h('p', { class: 'small' }, 'Students won\'t see any of this until you post grades.'),
        nComments ? h('p', { class: 'muted small' }, `Comments will show as from ${who}.`) : null),
      h('div', { class: 'row-btns' },
        h('button', { class: 'ghost', id: 'cfi-cancel', onclick: () => { state.confirming = false; state.focusAfterRender = 'cfi-post'; render(); } }, 'Cancel'),
        h('button', { class: 'primary', id: 'cfi-yes', onclick: runApply }, 'Yes, post')));
  }

  async function runApply() {
    const changes = state.plan.changes.filter((c) => c.selected);
    state.confirming = false; state.applying = true; state.stopRequested = false;
    state.progress = { done: 0, total: changes.length };
    state.focusAfterRender = 'cfi-progress-title';
    render();
    const results = await apply.applyAll(canvas, courseId, changes, state.assignmentsById,
      (done, total) => { state.progress = { done, total }; updateProgress(); },
      () => state.stopRequested, 3);
    state.applying = false;
    state.results = results;
    state.focusAfterRender = 'cfi-results-title';
    const ok = results.filter((r) => r.status === 'done').length;
    render();
    say(`Finished. ${ok} of ${results.length} posted.`);
  }

  function progressView() {
    const { done, total } = state.progress;
    return h('section', { class: 'box' },
      h('h3', { id: 'cfi-progress-title', tabindex: '-1' }, 'Posting to Canvas'),
      h('div', { class: 'bar', role: 'progressbar', 'aria-labelledby': 'cfi-progress-title', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done) },
        h('div', { class: 'fill', style: `width:${total ? (100 * done / total) : 0}%` })),
      h('p', { class: 'muted', id: 'cfi-progress-text' }, `${done} of ${total} done. Keep this tab open.`),
      h('button', { class: 'ghost', id: 'cfi-stop', disabled: state.stopRequested, onclick: () => { state.stopRequested = true; render(); } },
        state.stopRequested ? 'Stopping after the current ones…' : 'Stop'));
  }

  function updateProgress() {
    const bar = shadow.querySelector('.bar'); const fill = shadow.querySelector('.fill'); const txt = shadow.getElementById('cfi-progress-text');
    const { done, total } = state.progress;
    if (!bar) return render();
    bar.setAttribute('aria-valuenow', String(done));
    fill.style.width = `${total ? (100 * done / total) : 0}%`;
    txt.textContent = `${done} of ${total} done. Keep this tab open.`;
  }

  const STATUS_LABEL = {
    done: 'Posted and checked', skipped: 'Already in Canvas', conflict: 'Changed in Canvas meanwhile, left alone',
    failed: 'Didn\'t go through', unverified: 'Needs a quick check', not_started: 'Not posted (stopped)',
  };

  function resultsView() {
    const r = state.results;
    const by = {};
    r.forEach((x) => { (by[x.status] = by[x.status] || []).push(x); });
    const problems = r.filter((x) => !['done', 'skipped'].includes(x.status));
    const done = by.done || [];
    const hiddenAssignments = [];
    for (const x of done) {
      const a = state.assignmentsById[x.change.assignmentId];
      if (a && !x.change.visibleNow && !hiddenAssignments.includes(a)) hiddenAssignments.push(a);
    }
    return [
      r.abortReason ? errorBox(r.abortReason) : null,
      h('section', { class: 'summary' },
        h('h3', { class: 'big', id: 'cfi-results-title', tabindex: '-1' }, problems.length ? `${done.length} of ${r.length} posted` : 'All posted'),
        h('ul', { class: 'facts' }, Object.keys(STATUS_LABEL).filter((k) => by[k]).map((k) =>
          h('li', { class: 'st-' + k }, `${STATUS_LABEL[k]}: ${by[k].length}`)))),
      hiddenAssignments.length ? h('section', { class: 'box' },
        h('h3', null, 'Students can\'t see these yet'),
        h('p', { class: 'small' }, `${hiddenAssignments.map((a) => `"${a.name}"`).join(', ')} ${hiddenAssignments.length === 1 ? 'is' : 'are'} set to post grades manually. When you're ready, post grades from the Gradebook.`),
        h('a', { class: 'link', href: `/courses/${courseId}/gradebook`, target: '_top' }, 'Open the Gradebook')) : null,
      problems.length ? h('section', { class: 'box issues' },
        h('h3', null, 'Needs attention'),
        h('ul', null, problems.map((x) => h('li', { class: x.status === 'unverified' ? 'warning' : 'error' },
          h('span', { class: 'row' }, `Row ${x.change.row}`), `${x.change.studentName}, ${x.change.assignmentName}: ${x.message} `,
          h('a', { href: speedGraderUrl(x.change.assignmentId, x.change.studentId), target: '_blank', rel: 'noopener' }, 'Open in SpeedGrader'))))) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'ghost', id: 'cfi-results-dl', onclick: () => download(`${safeName(courseLabel())}_feedback_results_${today()}.csv`, apply.resultsToRows(r)) }, 'Download a record'),
        h('button', { class: 'primary', id: 'cfi-again', onclick: () => {
          state.results = null; state.plan = null; state.fileName = ''; state.lastFile = null; state.fileNote = '';
          state.focusAfterRender = 'cfi-file'; render();
        } }, 'Upload another file')),
      h('p', { class: 'muted small' }, 'Uploading the same file again is safe. Anything already in Canvas is skipped.'),
    ];
  }

  function errorBox(message) {
    return h('div', { class: 'error-box', role: 'alert' }, message);
  }
})();

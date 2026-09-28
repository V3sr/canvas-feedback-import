/*
 * Canvas REST calls made with the signed-in browser session on canvas.ubc.ca.
 * Only same-origin requests are made; nothing leaves Canvas.
 */
(function (root) {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastServerDate = null;
  // Canvas's clock (from the Date header), so template times line up with
  // graded_at even when the laptop clock is off.
  function serverNow() { return lastServerDate || new Date(); }

  class CanvasError extends Error {
    constructor(message, status, uncertain) {
      super(message);
      this.status = status;
      // true when we can't tell whether a write reached Canvas (network drop, timeout)
      this.uncertain = !!uncertain;
    }
  }

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function toQuery(params) {
    const parts = [];
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null) continue;
      const vals = Array.isArray(v) ? v : [v];
      for (const x of vals) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(x));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  async function readError(res) {
    try {
      const body = await res.json();
      if (body && body.errors) {
        if (Array.isArray(body.errors)) return body.errors.map((e) => e.message || JSON.stringify(e)).join('; ');
        return Object.entries(body.errors).map(([k, v]) =>
          `${k}: ${Array.isArray(v) ? v.map((e) => e.message || e).join(', ') : JSON.stringify(v)}`).join('; ');
      }
      if (body && body.message) return body.message;
    } catch (e) { /* not JSON */ }
    return `Canvas returned ${res.status}`;
  }

  async function request(method, url, body, attempt) {
    attempt = attempt || 0;
    const isWrite = method !== 'GET';
    const headers = { Accept: 'application/json+canvas-string-ids, application/json' };
    if (isWrite) {
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = csrfToken();
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }
    let res;
    try {
      res = await fetch(url, {
        method, headers, credentials: 'same-origin',
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (!isWrite && attempt < 3) { await sleep(800 * (attempt + 1)); return request(method, url, body, attempt + 1); }
      const err = new CanvasError('Couldn\'t reach Canvas. Check your internet connection.', 0, isWrite);
      err.network = true;
      throw err;
    }
    // Canvas throttles with 403 "Rate Limit Exceeded" (or 429). Throttled
    // requests are rejected before processing, so retrying writes is safe here.
    let throttled = res.status === 429;
    if (res.status === 403) {
      const text = await res.clone().text().catch(() => '');
      throttled = /rate limit/i.test(text);
    }
    if (throttled && attempt < 5) {
      await sleep(1500 * (attempt + 1)); return request(method, url, body, attempt + 1);
    }
    if (res.status >= 500 && !isWrite && attempt < 3) {
      await sleep(1000 * (attempt + 1)); return request(method, url, body, attempt + 1);
    }
    const dateHeader = res.headers.get('Date');
    if (dateHeader) { const d = new Date(dateHeader); if (!isNaN(d)) lastServerDate = d; }
    if (res.status === 401) {
      const text = await res.clone().text().catch(() => '');
      if (/not authorized|unauthorized/i.test(text) && !/authorization required|unauthenticated/i.test(text)) {
        const e = new CanvasError('Canvas says you don\'t have permission to change this. This happens for TAs limited to their own sections, concluded courses, or closed grading periods.', 401);
        e.permission = true;
        throw e;
      }
      const e = new CanvasError('Your Canvas session has ended. Refresh the page, sign in again, and upload the file again. Anything already posted will be skipped.', 401);
      e.sessionLost = true;
      throw e;
    }
    if (!res.ok) throw new CanvasError(await readError(res), res.status, res.status >= 500 && isWrite);
    return res;
  }

  function nextLink(res) {
    const link = res.headers.get('Link') || '';
    for (const part of link.split(',')) {
      const m = part.match(/<([^>]+)>;\s*rel="next"/);
      if (m) return m[1];
    }
    return null;
  }

  async function getAll(path, params) {
    let url = path + toQuery(Object.assign({ per_page: 100 }, params));
    const out = [];
    while (url) {
      const res = await request('GET', url);
      const data = await res.json();
      if (Array.isArray(data)) out.push(...data); else out.push(data);
      url = nextLink(res);
    }
    return out;
  }

  async function getJson(path, params) {
    const res = await request('GET', path + toQuery(params));
    return res.json();
  }

  // ---------- Course data ----------

  async function loadCourse(courseId) {
    return getJson(`/api/v1/courses/${courseId}`, { 'include[]': ['concluded'] });
  }

  async function whoAmI() {
    return getJson('/api/v1/users/self');
  }

  async function loadAssignments(courseId) {
    const list = await getAll(`/api/v1/courses/${courseId}/assignments`, { order_by: 'position' });
    return list.map((a) => ({
      id: String(a.id), name: a.name, points_possible: a.points_possible,
      grading_type: a.grading_type, published: a.published !== false,
      post_manually: !!a.post_manually,
      use_rubric_for_grading: !!a.use_rubric_for_grading,
      submission_types: a.submission_types || [],
      in_closed_grading_period: !!a.in_closed_grading_period,
      position: a.position,
      anonymous_grading: !!a.anonymous_grading, moderated_grading: !!a.moderated_grading,
      group_category_id: a.group_category_id || null,
      grade_group_students_individually: !!a.grade_group_students_individually,
      due_at: a.due_at || null,
    }));
  }

  async function loadStudents(courseId) {
    const [enrollments, sections] = await Promise.all([
      getAll(`/api/v1/courses/${courseId}/enrollments`, { 'type[]': ['StudentEnrollment'], 'state[]': ['active', 'invited'] }),
      getAll(`/api/v1/courses/${courseId}/sections`),
    ]);
    const sectionName = {};
    sections.forEach((s) => { sectionName[String(s.id)] = s.name; });
    const byId = new Map();
    for (const e of enrollments) {
      const u = e.user || {};
      const id = String(e.user_id || u.id);
      let s = byId.get(id);
      if (!s) {
        s = {
          id, sortable_name: u.sortable_name || u.name || '', name: u.name || '', short_name: u.short_name || '',
          sis_user_id: u.sis_user_id || e.sis_user_id || '',
          login_id: u.login_id || '', sections: [],
        };
        byId.set(id, s);
      }
      const sec = sectionName[String(e.course_section_id)];
      if (sec && !s.sections.includes(sec)) s.sections.push(sec);
    }
    return Array.from(byId.values());
  }

  function simplifySubmission(s) {
    return {
      score: s.score, entered_score: s.entered_score, grade: s.grade, entered_grade: s.entered_grade,
      excused: !!s.excused, workflow_state: s.workflow_state,
      graded_at: s.graded_at || null, posted_at: s.posted_at || null, grader_id: s.grader_id == null ? null : String(s.grader_id),
      comments: (s.submission_comments || []).map((c) => ({
        id: String(c.id), author_id: c.author_id == null ? null : String(c.author_id),
        text: c.comment || '', created_at: c.created_at || null,
      })),
    };
  }

  // Returns { `${assignmentId}:${userId}`: simplified submission }
  async function loadSubmissions(courseId, assignmentIds, withComments) {
    const out = {};
    const ids = Array.from(assignmentIds);
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      const params = { 'student_ids[]': ['all'], 'assignment_ids[]': chunk };
      if (withComments) params['include[]'] = ['submission_comments'];
      const subs = await getAll(`/api/v1/courses/${courseId}/students/submissions`, params);
      for (const s of subs) out[`${s.assignment_id}:${s.user_id}`] = simplifySubmission(s);
    }
    return out;
  }

  async function getSubmission(courseId, assignmentId, userId) {
    const s = await getJson(`/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`,
      { 'include[]': ['submission_comments'] });
    return simplifySubmission(s);
  }

  // One request per student/assignment so grade and comment land together.
  async function updateSubmission(courseId, assignmentId, userId, change) {
    const body = {};
    if (change.grade) {
      // posted_grade '' clears the grade (used by undo); Canvas accepts "85%" on points assignments.
      body.submission = change.grade.excuse ? { excuse: true } : { posted_grade: change.grade.posted == null ? '' : change.grade.posted };
    }
    if (change.comment) body.comment = { text_comment: change.comment };
    const res = await request('PUT', `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`, body);
    return res.json();
  }

  function commentUrl(courseId, assignmentId, userId, commentId) {
    return `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}/comments/${commentId}`;
  }
  // Only the comment's author can edit it; teachers can delete.
  async function editComment(courseId, assignmentId, userId, commentId, text) {
    const res = await request('PUT', commentUrl(courseId, assignmentId, userId, commentId), { comment: text });
    return res.json();
  }
  async function deleteComment(courseId, assignmentId, userId, commentId) {
    const res = await request('DELETE', commentUrl(courseId, assignmentId, userId, commentId));
    return res.json().catch(() => ({}));
  }

  const api = {
    CanvasError, serverNow, loadCourse, whoAmI, loadAssignments, loadStudents, loadSubmissions,
    getSubmission, updateSubmission, editComment, deleteComment, toQuery,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CFI = root.CFI || {}; root.CFI.canvas = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);

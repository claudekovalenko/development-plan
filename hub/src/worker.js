// Kovalenko Creatives hub. Cloudflare Access sits in front of the whole Worker; this code
// checks the Access token again on every API call and decides what each person may see.
import { verifyAccessJwt } from './access.js';
// Development plans live outside public/ so the Worker hands them only to the core team.
import jpnPlan from '../plans/jpn.html';

const PLANS = { jpn: jpnPlan };

const COLLECTIONS = ['tasks', 'notes', 'comments', 'ideas', 'updates'];
const LIMITS = { note: 500, comment: 2000, topicTitle: 200, decisionNote: 500, ideaTitle: 200, ideaDesc: 2000, weekLabel: 100, item: 500, items: 50, updateNotes: 2000 };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
const fail = (status, error) => json({ error }, status);

// Writes must be same-site JSON: a form or a text/plain request from another website could
// otherwise ride on the visitor's Access cookie. Returns an error response or null.
function writeGuard(request, url) {
  const site = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  const sameSite = site ? (site === 'same-origin' || site === 'none') : origin === url.origin;
  if (!sameSite) return fail(403, 'Cross-site requests are not allowed.');
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return fail(415, 'Send JSON.');
  return null;
}

function isLocal(url) {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

// The signed-in email, or null. A development bypass exists only when DEV_USER_EMAIL is set
// and the request is to localhost; production never sets DEV_USER_EMAIL.
async function whoIs(request, env, url) {
  if (env.DEV_USER_EMAIL && isLocal(url)) {
    return (request.headers.get('x-dev-user') || env.DEV_USER_EMAIL).trim().toLowerCase();
  }
  return verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUD,
  });
}

async function memberRows(env, email) {
  const { results } = await env.DB.prepare('SELECT project_id, role, display_name FROM members WHERE email = ?').bind(email).all();
  return results;
}

async function visibleProjects(env, rows) {
  if (rows.some((r) => r.project_id === '*')) {
    return (await env.DB.prepare('SELECT id, name FROM projects ORDER BY sort, name').all()).results;
  }
  const ids = rows.map((r) => r.project_id);
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  return (await env.DB.prepare(`SELECT id, name FROM projects WHERE id IN (${marks}) ORDER BY sort, name`).bind(...ids).all()).results;
}

const canSee = (rows, projectId) => rows.some((r) => r.project_id === '*' || r.project_id === projectId);

// The strongest role a person holds on a project ('*' rows apply to every project), or null.
const RANK = { owner: 4, core: 3, client: 2, commenter: 1 };
function roleFor(rows, projectId) {
  let best = null;
  for (const r of rows) {
    if ((r.project_id === '*' || r.project_id === projectId) && RANK[r.role] && (!best || RANK[r.role] > RANK[best])) best = r.role;
  }
  return best;
}
const isCore = (role) => role === 'owner' || role === 'core';
// Payment terms are between the owner and the client only.
const seesPayments = (role) => role === 'owner' || role === 'client';

// Other people are shown by display name (or the part before @), never by full email.
async function nameMap(env) {
  const { results } = await env.DB.prepare('SELECT email, MAX(display_name) AS display_name FROM members GROUP BY email').all();
  const map = new Map();
  for (const r of results) map.set(r.email, r.display_name || r.email.split('@')[0]);
  return map;
}
const displayName = (map, author) => (author.includes('@') ? map.get(author) || author.split('@')[0] : author.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()));

async function listCollection(env, projectId, col) {
  const names = await nameMap(env);
  const by = (a) => displayName(names, a);
  if (col === 'tasks') {
    const { results } = await env.DB.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY sort_order').bind(projectId).all();
    return results.map((t) => ({ id: t.id, title: t.title, group: t.task_group, order: t.sort_order, stoppingPoint: t.stopping_point,
      completed: t.completed === 1, completedDate: t.completed_date, completedBy: t.completed_by, date: t.date_label }));
  }
  // A request shows as done once the task its approval created is ticked.
  const sql = col === 'ideas'
    ? 'SELECT i.*, t.completed AS task_done FROM ideas i LEFT JOIN tasks t ON t.project_id = i.project_id AND t.id = i.task_id WHERE i.project_id = ? ORDER BY i.created_at'
    : `SELECT * FROM ${col} WHERE project_id = ? ORDER BY created_at`;
  const { results } = await env.DB.prepare(sql).bind(projectId).all();
  return results.map((r) => {
    const base = { id: String(r.id), authorName: by(r.author_email), createdAt: r.created_at };
    if (col === 'notes') return { ...base, taskId: r.task_id, text: r.text };
    if (col === 'comments') return { ...base, text: r.text, title: r.title || '', threadId: r.thread_id == null ? null : String(r.thread_id) };
    if (col === 'ideas') {
      return { ...base, title: r.title, description: r.description, status: r.status,
        decidedBy: r.decided_by ? by(r.decided_by) : null, decidedAt: r.decided_at, decisionNote: r.decision_note,
        taskId: r.task_id, taskDone: r.task_done === 1 };
    }
    let items = [];
    try { items = JSON.parse(r.items); } catch { items = []; }
    return { ...base, weekLabel: r.week_label, items, notes: r.notes, builtin: !r.author_email.includes('@') };
  });
}

function text(v, max, required = true) {
  if (typeof v !== 'string') return required ? null : '';
  const s = v.trim();
  if (required && !s) return null;
  return s.length > max ? null : s;
}

async function addRow(env, projectId, col, body, email) {
  const now = Date.now();
  if (col === 'notes') {
    const t = text(body.text, LIMITS.note), taskId = text(body.taskId, 40);
    if (!t || !taskId) return fail(400, 'A note needs text (up to 500 characters).');
    const task = await env.DB.prepare('SELECT 1 FROM tasks WHERE project_id = ? AND id = ?').bind(projectId, taskId).first();
    if (!task) return fail(404, 'No such task.');
    const r = await env.DB.prepare('INSERT INTO notes (project_id, task_id, text, author_email, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(projectId, taskId, t, email, now).run();
    return json({ id: String(r.meta.last_row_id) }, 201);
  }
  if (col === 'comments') {
    const t = text(body.text, LIMITS.comment);
    if (!t) return fail(400, 'A message needs text (up to 2,000 characters).');
    // A reply names the topic it answers; a new topic has a title instead.
    if (body.threadId != null) {
      if (body.title != null) return fail(400, 'A reply has no title.');
      const threadId = typeof body.threadId === 'string' && /^[1-9][0-9]{0,15}$/.test(body.threadId) ? Number(body.threadId) : null;
      const topic = threadId && await env.DB.prepare('SELECT 1 FROM comments WHERE id = ? AND project_id = ? AND thread_id IS NULL').bind(threadId, projectId).first();
      if (!topic) return fail(404, 'No such conversation.');
      const r = await env.DB.prepare('INSERT INTO comments (project_id, thread_id, text, author_email, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(projectId, threadId, t, email, now).run();
      return json({ id: String(r.meta.last_row_id) }, 201);
    }
    // The page asks for a title; without one, the topic is shown by its first line.
    if (body.title != null && typeof body.title !== 'string') return fail(400, 'A title must be text.');
    const title = text(body.title, LIMITS.topicTitle, false);
    if (title === null) return fail(400, 'A title can be up to 200 characters.');
    const r = await env.DB.prepare('INSERT INTO comments (project_id, title, text, author_email, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(projectId, title || null, t, email, now).run();
    return json({ id: String(r.meta.last_row_id) }, 201);
  }
  if (col === 'ideas') {
    if (body.description != null && typeof body.description !== 'string') return fail(400, 'An idea\'s description must be text.');
    const title = text(body.title, LIMITS.ideaTitle), desc = text(body.description, LIMITS.ideaDesc, false);
    if (!title || desc === null) return fail(400, 'A request needs a title (up to 200 characters).');
    const r = await env.DB.prepare('INSERT INTO ideas (project_id, title, description, author_email, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(projectId, title, desc, email, now).run();
    return json({ id: String(r.meta.last_row_id) }, 201);
  }
  if (col === 'updates') {
    const week = text(body.weekLabel, LIMITS.weekLabel), notes = text(body.notes, LIMITS.updateNotes, false);
    const items = Array.isArray(body.items) ? body.items.map((i) => text(i, LIMITS.item)).filter((i) => i) : [];
    if (!week || notes === null || !items.length || items.length > LIMITS.items || items.length !== body.items.length) {
      return fail(400, 'An update needs a week label and 1–50 items of up to 500 characters each.');
    }
    const r = await env.DB.prepare('INSERT INTO updates (project_id, week_label, items, notes, author_email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(projectId, week, JSON.stringify(items), notes, email, now).run();
    return json({ id: String(r.meta.last_row_id) }, 201);
  }
  return fail(405, 'Tasks are added by the project owner.');
}

// Approve or decline a waiting request. Approving adds it to Progress as a task, in the same
// transaction, so a request is never approved without its task (or given two).
async function decideRequest(env, projectId, rawId, body, email) {
  const id = /^[1-9][0-9]{0,15}$/.test(rawId) ? Number(rawId) : null;
  if (!id) return fail(404, 'No such request.');
  if (body.decision !== 'approved' && body.decision !== 'declined') return fail(400, 'Send { "decision": "approved" or "declined" }.');
  if (body.note != null && typeof body.note !== 'string') return fail(400, 'A note must be text.');
  const note = text(body.note, LIMITS.decisionNote, false);
  if (note === null) return fail(400, 'A note can be up to 500 characters.');
  const now = Date.now();
  const taskId = 'req-' + id;
  const decide = env.DB.prepare(`UPDATE ideas SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, task_id = ?
    WHERE id = ? AND project_id = ? AND status = 'waiting'`)
    .bind(body.decision, email, now, note, body.decision === 'approved' ? taskId : null, id, projectId);
  let changed;
  if (body.decision === 'approved') {
    // A decided request says so; for a waiting one, only a task added by hand could already have
    // this id, so name that rather than fail.
    const current = await env.DB.prepare('SELECT status FROM ideas WHERE id = ? AND project_id = ?').bind(id, projectId).first();
    if (!current) return fail(404, 'No such request.');
    if (current.status !== 'waiting') return fail(409, 'This request has already been decided.');
    if (await env.DB.prepare('SELECT 1 FROM tasks WHERE project_id = ? AND id = ?').bind(projectId, taskId).first()) {
      return fail(409, 'A task named ' + taskId + ' already exists, so this request can\'t be added to Progress.');
    }
    const [addTask, update] = await env.DB.batch([
      env.DB.prepare(`INSERT INTO tasks (project_id, id, title, task_group, sort_order)
        SELECT project_id, ?, title, 'requests', ? FROM ideas WHERE id = ? AND project_id = ? AND status = 'waiting'`)
        .bind(taskId, now, id, projectId),
      decide,
    ]);
    changed = update.meta.changes;
    // Both statements see the same row inside the batch's transaction, so these always match.
    if (addTask.meta.changes !== changed) console.error('request and task out of step', id);
  } else {
    changed = (await decide.run()).meta.changes;
  }
  if (!changed) {
    const row = await env.DB.prepare('SELECT status FROM ideas WHERE id = ? AND project_id = ?').bind(id, projectId).first();
    return row ? fail(409, 'This request has already been decided.') : fail(404, 'No such request.');
  }
  return json({ ok: true, status: body.decision, taskId: body.decision === 'approved' ? taskId : null });
}

async function updateTask(env, projectId, taskId, body, email) {
  if (typeof body.completed !== 'boolean') return fail(400, 'Send { "completed": true or false }.');
  const names = await nameMap(env);
  const date = body.completed
    ? new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' })
    : null;
  const r = await env.DB.prepare('UPDATE tasks SET completed = ?, completed_date = ?, completed_by = ? WHERE project_id = ? AND id = ?')
    .bind(body.completed ? 1 : 0, date, body.completed ? displayName(names, email) : null, projectId, taskId).run();
  if (!r.meta.changes) return fail(404, 'No such task.');
  return json({ ok: true });
}

async function api(request, env, url) {
  const email = await whoIs(request, env, url);
  if (!email) return fail(401, 'Sign in through Cloudflare Access.');
  const rows = await memberRows(env, email);
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"

  if (parts.length === 1 && parts[0] === 'me' && request.method === 'GET') {
    const own = rows.find((r) => r.display_name);
    const projects = (await visibleProjects(env, rows)).map((p) => ({ ...p, role: roleFor(rows, p.id) }));
    return json({ email, displayName: own ? own.display_name : email.split('@')[0], projects });
  }

  if (parts[0] !== 'projects' || parts.length < 3 || parts.length > 4) return fail(404, 'Not found.');
  const projectId = parts[1], col = parts[2];
  if (!/^[a-z0-9-]{1,40}$/.test(projectId)) return fail(404, 'Not found.');
  if (!canSee(rows, projectId)) return fail(403, 'You do not have access to this project.');
  const role = roleFor(rows, projectId);

  if (col === 'plan' && parts.length === 3 && request.method === 'GET') {
    if (!isCore(role)) return fail(403, 'Only the core team can see the plan.');
    return json({ html: Object.hasOwn(PLANS, projectId) ? PLANS[projectId] : '' });
  }
  if (col === 'private' && parts.length === 3 && request.method === 'GET') {
    if (!seesPayments(role)) return fail(403, 'Only the owner and the client can see this section.');
    const { results } = await env.DB.prepare('SELECT key, html FROM project_private WHERE project_id = ?').bind(projectId).all();
    const sections = {};
    for (const r of results) sections[r.key] = r.html;
    return json({ sections });
  }
  if (!COLLECTIONS.includes(col)) return fail(404, 'Not found.');

  if (parts.length === 3 && request.method === 'GET') return json({ rows: await listCollection(env, projectId, col) });

  if (!['POST', 'PATCH'].includes(request.method)) return fail(405, 'Method not allowed.');
  const blocked = writeGuard(request, url);
  if (blocked) return blocked;
  const raw = await request.text();
  if (raw.length > 32 * 1024) return fail(413, 'Too large.');
  let body;
  try { body = JSON.parse(raw); } catch { return fail(400, 'Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Invalid JSON.');

  if (parts.length === 3 && request.method === 'POST') {
    if (col === 'updates' && !isCore(role)) return fail(403, 'Weekly updates are posted by the core team.');
    return addRow(env, projectId, col, body, email);
  }
  if (parts.length === 4 && request.method === 'PATCH' && col === 'ideas') {
    if (!isCore(role)) return fail(403, 'Requests are approved by the owner and the core team.');
    return decideRequest(env, projectId, parts[3], body, email);
  }
  if (parts.length === 4 && request.method === 'PATCH' && col === 'tasks') {
    if (!isCore(role)) return fail(403, 'Only the core team ticks tasks.');
    return updateTask(env, projectId, parts[3], body, email);
  }
  return fail(405, 'Method not allowed.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (err) {
        console.error('api error', err && err.message);
        return fail(500, 'Something went wrong.');
      }
    }
    return env.ASSETS.fetch(request);
  },
};

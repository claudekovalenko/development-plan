// Kovalenko Creatives hub. Cloudflare Access sits in front of the whole Worker; this code
// checks the Access token again on every API call and decides what each person may see.
import { verifyAccessJwt } from './access.js';

const COLLECTIONS = ['tasks', 'notes', 'comments', 'ideas', 'updates'];
const LIMITS = { note: 500, comment: 2000, ideaTitle: 200, ideaDesc: 2000, weekLabel: 100, item: 500, items: 50, updateNotes: 2000 };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
const fail = (status, error) => json({ error }, status);

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
  const { results } = await env.DB.prepare(`SELECT * FROM ${col} WHERE project_id = ? ORDER BY created_at`).bind(projectId).all();
  return results.map((r) => {
    const base = { id: String(r.id), authorName: by(r.author_email), createdAt: r.created_at };
    if (col === 'notes') return { ...base, taskId: r.task_id, text: r.text };
    if (col === 'comments') return { ...base, text: r.text };
    if (col === 'ideas') return { ...base, title: r.title, description: r.description };
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
    if (!t) return fail(400, 'A comment needs text (up to 2,000 characters).');
    const r = await env.DB.prepare('INSERT INTO comments (project_id, text, author_email, created_at) VALUES (?, ?, ?, ?)')
      .bind(projectId, t, email, now).run();
    return json({ id: String(r.meta.last_row_id) }, 201);
  }
  if (col === 'ideas') {
    const title = text(body.title, LIMITS.ideaTitle), desc = text(body.description, LIMITS.ideaDesc, false);
    if (!title || desc === null) return fail(400, 'An idea needs a title (up to 200 characters).');
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
    return json({ email, displayName: own ? own.display_name : email.split('@')[0], projects: await visibleProjects(env, rows) });
  }

  if (parts[0] !== 'projects' || parts.length < 3 || parts.length > 4) return fail(404, 'Not found.');
  const projectId = parts[1], col = parts[2];
  if (!/^[a-z0-9-]{1,40}$/.test(projectId)) return fail(404, 'Not found.');
  if (!canSee(rows, projectId)) return fail(403, 'You do not have access to this project.');

  if (col === 'private' && parts.length === 3 && request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT key, html FROM project_private WHERE project_id = ?').bind(projectId).all();
    const sections = {};
    for (const r of results) sections[r.key] = r.html;
    return json({ sections });
  }
  if (!COLLECTIONS.includes(col)) return fail(404, 'Not found.');

  if (parts.length === 3 && request.method === 'GET') return json({ rows: await listCollection(env, projectId, col) });

  if (!['POST', 'PATCH'].includes(request.method)) return fail(405, 'Method not allowed.');
  if (!(request.headers.get('content-type') || '').includes('application/json')) return fail(415, 'Send JSON.');
  const raw = await request.text();
  if (raw.length > 32 * 1024) return fail(413, 'Too large.');
  let body;
  try { body = JSON.parse(raw); } catch { return fail(400, 'Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Invalid JSON.');

  if (parts.length === 3 && request.method === 'POST') return addRow(env, projectId, col, body, email);
  if (parts.length === 4 && request.method === 'PATCH' && col === 'tasks') return updateTask(env, projectId, parts[3], body, email);
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

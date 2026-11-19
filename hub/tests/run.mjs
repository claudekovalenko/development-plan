// End-to-end checks: runs the Worker locally with a local D1, loads the schema, seed and
// made-up members/private content, then drives the page and the API.
// Usage (from hub/): node tests/run.mjs     Needs: npx (wrangler@4), Playwright + Chromium.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

const DB = 'kovalenko-creatives-hub';
const dir = mkdtempSync(join(tmpdir(), 'hub-test-'));
const persist = join(dir, 'state');
// Test identities only; real members are loaded at setup from a private file.
const OWNER = 'owner' + '@' + 'example.test', MEMBER = 'member' + '@' + 'example.test', OUTSIDER = 'outsider' + '@' + 'example.test';
let failures = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || !extra ? '' : '  — ' + extra)); if (!cond) failures++; };

function wrangler(args, opts = {}) {
  return execFileSync('npx', ['--yes', 'wrangler@4', ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
}
function d1File(file) { wrangler(['d1', 'execute', DB, '--local', '--persist-to', persist, '--file', file]); }

writeFileSync(join(dir, 'members.sql'), `
INSERT INTO projects (id, name, sort) VALUES ('demo', 'Demo project', 2);
INSERT INTO members (email, project_id, role, display_name) VALUES ('${OWNER}', '*', 'owner', 'Owner Person');
INSERT INTO members (email, project_id, role, display_name) VALUES ('${MEMBER}', 'jpn', 'member', NULL);
`);
writeFileSync(join(dir, 'private.sql'), `
INSERT INTO project_private (project_id, key, html, updated_at) VALUES
 ('jpn', 'payment-section', '<section aria-labelledby="split"><p class="label" id="split">TEST PAYMENT SECTION</p></section>', 1),
 ('jpn', 'stage-1-amount', '<span class="amount">TEST-AMOUNT-1</span>', 1),
 ('jpn', 'agreement-payment', '<li>TEST AGREEMENT LINE</li>', 1);
`);
for (const f of ['schema.sql', 'seed.sql', join(dir, 'members.sql'), join(dir, 'private.sql')]) d1File(f);
check('schema, seed and test data load into a local D1', true);

const servers = [];
function startServer(port, vars) {
  const args = ['--yes', 'wrangler@4', 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const p = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  let log = ''; p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
  servers.push(p);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = async () => {
      try { const r = await fetch(`http://127.0.0.1:${port}/index.html`); if (r.status) return resolve(); } catch {}
      if (Date.now() - started > 90000) return reject(new Error('server did not start:\n' + log.slice(-2000)));
      setTimeout(poll, 500);
    };
    poll();
  });
}
const DEV = 8791, PROD = 8792;
await startServer(DEV, { DEV_USER_EMAIL: OWNER });
await startServer(PROD, { ACCESS_TEAM_DOMAIN: 'test-team.invalid', ACCESS_AUD: 'test-aud' });
const base = `http://127.0.0.1:${DEV}`;
const api = (path, { as = OWNER, method = 'GET', body, type = 'application/json', port = DEV, headers = {} } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-dev-user': as, ...(body !== undefined ? { 'content-type': type } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });

try {
  // --- API: who sees what
  let r = await api('/api/me'); let me = await r.json();
  check('owner sees every project', r.status === 200 && me.projects.map((p) => p.id).join(',') === 'jpn,demo', JSON.stringify(me));
  r = await api('/api/me', { as: MEMBER }); me = await r.json();
  check('member sees only their project', r.status === 200 && me.projects.map((p) => p.id).join(',') === 'jpn');
  check('member without a display name is shown by the part before @', me.displayName === 'member');
  r = await api('/api/me', { as: OUTSIDER }); me = await r.json();
  check('outsider is signed in but sees no projects', r.status === 200 && me.projects.length === 0);
  for (const path of ['/api/projects/jpn/comments', '/api/projects/jpn/tasks', '/api/projects/jpn/private', '/api/projects/jpn/updates']) {
    check('outsider gets 403 on ' + path, (await api(path, { as: OUTSIDER })).status === 403);
  }
  check('outsider cannot post to jpn', (await api('/api/projects/jpn/comments', { as: OUTSIDER, method: 'POST', body: { text: 'hi' } })).status === 403);
  check('member gets 403 on a project they are not in', (await api('/api/projects/demo/comments', { as: MEMBER })).status === 403);
  check('member gets 403 on another project\'s private content', (await api('/api/projects/demo/private', { as: MEMBER })).status === 403);
  r = await api('/api/projects/jpn/private', { as: MEMBER });
  check('member reads their project\'s private content', r.status === 200 && (await r.json()).sections['stage-1-amount'].includes('TEST-AMOUNT-1'));

  // --- API: input checks
  check('empty comment is refused', (await api('/api/projects/jpn/comments', { as: MEMBER, method: 'POST', body: { text: '   ' } })).status === 400);
  check('over-long comment is refused', (await api('/api/projects/jpn/comments', { as: MEMBER, method: 'POST', body: { text: 'x'.repeat(2001) } })).status === 400);
  check('non-JSON body is refused', (await api('/api/projects/jpn/comments', { as: MEMBER, method: 'POST', body: 'text=hi', type: 'application/x-www-form-urlencoded' })).status === 415);
  check('broken JSON is refused', (await api('/api/projects/jpn/comments', { as: MEMBER, method: 'POST', body: '{"text":' })).status === 400);
  check('adding tasks is refused', (await api('/api/projects/jpn/tasks', { as: MEMBER, method: 'POST', body: { title: 'x' } })).status === 405);
  check('task update needs a true/false', (await api('/api/projects/jpn/tasks/task-24', { as: MEMBER, method: 'PATCH', body: { completed: 'yes' } })).status === 400);
  check('unknown task is 404', (await api('/api/projects/jpn/tasks/nope', { as: MEMBER, method: 'PATCH', body: { completed: true } })).status === 404);
  check('note on an unknown task is 404', (await api('/api/projects/jpn/notes', { as: MEMBER, method: 'POST', body: { taskId: 'nope', text: 'x' } })).status === 404);
  check('update with too many items is refused', (await api('/api/projects/jpn/updates', { as: MEMBER, method: 'POST', body: { weekLabel: 'W', items: Array(51).fill('x') } })).status === 400);
  check('unknown collection is 404', (await api('/api/projects/jpn/members', { as: OWNER })).status === 404);
  check('odd project id is 404', (await api('/api/projects/..%2Fjpn/comments', { as: OWNER })).status === 404);
  r = await api('/api/projects/jpn/comments', { as: OWNER, method: 'POST', body: { text: 'spoofed', authorName: 'Someone Else', createdAt: 1 } });
  const spoofList = (await (await api('/api/projects/jpn/comments')).json()).rows;
  const spoof = spoofList.find((c) => c.text === 'spoofed');
  check('author and time come from the server, not the request', r.status === 201 && spoof && spoof.authorName === 'Owner Person' && spoof.createdAt > 1);
  check('rows never carry anyone\'s email', !JSON.stringify(spoofList).includes('@'));

  // --- Access mode: no developer bypass, every API route needs a valid Access token
  const prodPaths = ['/api/me', '/api/projects/jpn/comments', '/api/projects/jpn/private', '/api/projects/jpn/tasks'];
  for (const p of prodPaths) check('without an Access token ' + p + ' is 401', (await api(p, { port: PROD })).status === 401);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({ email: OWNER, aud: ['test-aud'], iss: 'https://test-team.invalid', exp: 9999999999 }) + '.';
  check('a forged unsigned token is 401', (await api('/api/me', { port: PROD, headers: { 'Cf-Access-Jwt-Assertion': forged } })).status === 401);
  const fakeSig = b64({ alg: 'RS256', kid: 'k' }) + '.' + b64({ email: OWNER, aud: ['test-aud'], iss: 'https://test-team.invalid', exp: 9999999999 }) + '.' + Buffer.from('nope').toString('base64url');
  check('a token with a made-up signature is 401', (await api('/api/me', { port: PROD, headers: { 'Cf-Access-Jwt-Assertion': fakeSig } })).status === 401);
  check('the developer header does nothing without the developer setting', (await api('/api/me', { port: PROD, as: OWNER })).status === 401);
  check('a POST without a token is 401', (await api('/api/projects/jpn/comments', { port: PROD, method: 'POST', body: { text: 'x' } })).status === 401);
  r = await fetch(`http://127.0.0.1:${PROD}/index.html`);
  const pageSource = await r.text();
  check('the page itself carries no payment amounts', r.status === 200 && !/\$\s?\d/.test(pageSource));
  check('the page sends a Content-Security-Policy', (r.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));

  // --- Browser: two people on the same project
  let browser;
  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }
  const ctxFor = (who, width = 1280) => browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: { 'x-dev-user': who } });
  const errors = [];
  const watch = (page, who) => { page.on('pageerror', (e) => errors.push(who + ': ' + e.message)); page.on('dialog', (d) => { errors.push(who + ' dialog: ' + d.message()); d.dismiss(); }); };

  const mctx = await ctxFor(MEMBER); const m = await mctx.newPage(); watch(m, 'member');
  await m.goto(base + '/'); await m.waitForSelector('#comments-list', { state: 'attached' }); await m.waitForTimeout(1200);
  check('member sees the plan with private payment content', (await m.locator('.private-slot[data-key="payment-section"]').innerText()).includes('TEST PAYMENT SECTION'));
  check('member sees the stage amount', (await m.locator('.private-slot[data-key="stage-1-amount"]').innerText()).includes('TEST-AMOUNT-1'));
  check('member sees the private agreement line', (await m.locator('#agree-list').innerText()).includes('TEST AGREEMENT LINE'));
  check('payment link appears in the page contents', await m.locator('#toc-pay').isVisible());
  check('project picker is hidden with only one project', !(await m.locator('#hub-project-wrap').isVisible()));
  check('signed-in name shows', (await m.locator('#hub-user').innerText()).includes('member'));
  check('built-in weekly updates show in Recent updates', (await m.locator('#wh-grid').innerText()).length > 0);

  await m.click('#tab-comments');
  const xss = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
  await m.fill('#comment-text', 'Hello from the member ' + xss); await m.click('#comment-send'); await m.waitForTimeout(800);
  check('a posted comment appears', (await m.locator('#comments-list').innerText()).includes('Hello from the member'));
  check('HTML in a comment shows as text', (await m.locator('#comments-list').innerText()).includes('<img src=x'));
  check('HTML in a comment does not run', (await m.evaluate(() => window.__pwned)) === undefined);

  await m.click('#tab-progress'); await m.waitForSelector('.task-check');
  const box = m.locator('#chk-task-24'); const before = await box.isChecked();
  await box.click(); await m.waitForTimeout(800);
  await m.locator('.task-notes-area[data-task="task-24"] .notes-toggle').click();
  await m.fill('.task-notes-area[data-task="task-24"] .note-input', 'A note on this task'); await m.click('.task-notes-area[data-task="task-24"] .note-send'); await m.waitForTimeout(800);

  await m.click('#tab-updates');
  await m.fill('#update-items', 'Shipped the hub\n<b>bold?</b>'); await m.click('#update-send'); await m.waitForTimeout(800);
  check('a posted update shows in This week', (await m.locator('.wh-card.this-week').innerText()).includes('Shipped the hub'));

  await m.click('#tab-next');
  await m.fill('#idea-title', 'Idea from member'); await m.fill('#idea-desc', 'Details'); await m.click('#idea-send'); await m.waitForTimeout(800);

  await m.reload(); await m.waitForSelector('.task-check', { state: 'attached' }); await m.waitForTimeout(1200);
  check('ticked task stays ticked after reload', (await m.locator('#chk-task-24').isChecked()) === !before);
  check('note stays after reload', (await m.locator('.task-notes-area[data-task="task-24"]').innerText()).includes('1 note'));
  check('comment stays after reload', (await m.locator('#comments-list').innerText()).includes('Hello from the member'));
  check('idea stays after reload', (await m.locator('#ideas-list').innerText()).includes('Idea from member'));
  check('update item HTML shows as text', (await m.locator('#updates-list').innerText()).includes('<b>bold?</b>'));

  const octx = await ctxFor(OWNER); const o = await octx.newPage(); watch(o, 'owner');
  await o.goto(base + '/'); await o.waitForSelector('.task-check', { state: 'attached' }); await o.waitForTimeout(1200);
  check('the owner sees the member\'s comment', (await o.locator('#comments-list').innerText()).includes('Hello from the member'));
  check('the owner sees the member\'s ticked task', (await o.locator('#chk-task-24').isChecked()) === !before);
  check('the owner sees the member\'s update', (await o.locator('#wh-grid').innerText()).includes('Shipped the hub'));
  check('the owner gets a project picker', await o.locator('#hub-project-wrap').isVisible());
  check('no email address appears on the page', !(await o.locator('body').innerText()).includes('@example.test'));
  await o.selectOption('#hub-project', 'demo'); await o.waitForLoadState('load'); await o.waitForTimeout(1200);
  check('switching to another project hides the Jesus People Network plan', !(await o.locator('#plan-jpn').isVisible()) && await o.locator('#plan-other').isVisible());
  check('the other project shows none of jpn\'s comments', !(await o.locator('#comments-list').innerText()).includes('Hello from the member'));

  const xctx = await ctxFor(OUTSIDER); const x = await xctx.newPage(); watch(x, 'outsider');
  await x.goto(base + '/'); await x.waitForTimeout(1200);
  check('an outsider sees a no-access message', (await x.locator('#hub-error').innerText()).includes("doesn't have access"));
  check('an outsider sees no private content', !(await x.content()).includes('TEST-AMOUNT-1'));

  const pctx = await ctxFor(MEMBER, 390); const ph = await pctx.newPage(); watch(ph, 'phone');
  await ph.goto(base + '/'); await ph.waitForTimeout(1200);
  check('no sideways scroll on a phone', await ph.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));

  check('no page errors or pop-ups', errors.length === 0, errors.join(' | '));
  await browser.close();
} finally {
  for (const p of servers) { try { p.kill('SIGTERM'); } catch {} }
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} }, 500);
}
console.log(failures ? failures + ' check(s) failed' : 'all hub checks passed');
setTimeout(() => process.exit(failures ? 1 : 0), 800);

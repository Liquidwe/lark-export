import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  accountOf,
  adminEnabled,
  beginOAuth,
  checkAdminPassword,
  createSession,
  endSession,
  finishOAuth,
  memberTargetEnabled,
  publicUrl,
  readSession,
  removeAccount,
  saveAccount,
  takeOAuthState,
  upsertMember,
} from './auth.js';
import { db, parseJson } from './db.js';
import { deleteExport, pauseExport, resumeExport, retryNode, startExport, startLibraryExport } from './extract.js';
import {
  migratedUrl,
  migrationProgress,
  pauseMigration,
  previewMigration,
  resumeMigration,
  startLibraryMigration,
  startMigration,
} from './migrate.js';

const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const SESSION_COOKIE = 'lark_session';
const STATE_COOKIE = 'lark_oauth_state';
const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function exportSummary(job) {
  const rows = db
    .prepare(
      `SELECT obj_type, status, COUNT(*) AS n FROM nodes WHERE export_id = ? GROUP BY obj_type, status`,
    )
    .all(job.id);
  const byType = {};
  const byStatus = {};
  let total = 0;
  for (const row of rows) {
    byType[row.obj_type] = (byType[row.obj_type] || 0) + row.n;
    byStatus[row.status] = (byStatus[row.status] || 0) + row.n;
    total += row.n;
  }
  const size = db
    .prepare('SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS n FROM assets WHERE export_id = ?')
    .get(job.id);
  return { ...job, total, byType, byStatus, assetCount: size.n, assetBytes: size.bytes };
}

function exportDetail(job) {
  const nodes = db
    .prepare(
      `SELECT id, node_token, parent_token, obj_type, node_type, title, depth, status, error, stats, warnings
       FROM nodes WHERE export_id = ? ORDER BY position`,
    )
    .all(job.id)
    .map((node) => ({ ...node, stats: parseJson(node.stats, {}), warnings: parseJson(node.warnings, []) }));
  const totals = {};
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node.stats)) totals[key] = (totals[key] || 0) + value;
  }
  const migrations = db
    .prepare('SELECT id FROM migrations WHERE export_id = ? ORDER BY id DESC')
    .all(job.id)
    .map((row) => migrationDetail(row.id));
  return { ...exportSummary(job), nodes, totals, migrations };
}

function migrationDetail(id) {
  const job = db.prepare('SELECT * FROM migrations WHERE id = ?').get(id);
  if (!job) return null;
  const items = db
    .prepare(
      `SELECT i.node_id, i.status, i.error, i.warnings, i.target_node_token, i.target_obj_token, i.target_obj_type, i.duration_ms, n.title, n.obj_type, n.depth, n.space
       FROM migration_items i JOIN nodes n ON n.id = i.node_id
       WHERE i.migration_id = ? ORDER BY n.position`,
    )
    .all(id)
    .map((item) => ({
      ...item,
      warnings: parseJson(item.warnings, []),
      url: migratedUrl(job.target_host, item),
    }));
  return { ...job, counts: countItems(items), items, progress: migrationProgress(job, items) };
}

function countItems(items) {
  const counts = { total: items.length, done: 0, failed: 0, placeholder: 0 };
  for (const item of items) {
    if (item.status in counts) counts[item.status]++;
  }
  return counts;
}

// What the admin may see of members: names and numbers. Titles and errors can quote a document,
// so nothing here selects them.
function memberOverview() {
  return db
    .prepare('SELECT id, name, created_at FROM users ORDER BY id DESC')
    .all()
    .map((user) => {
      const read = db
        .prepare('SELECT id, status, created_at FROM exports WHERE owner_id = ? ORDER BY id DESC LIMIT 1')
        .get(user.id);
      const nodes = read
        ? db.prepare('SELECT status FROM nodes WHERE export_id = ?').all(read.id)
        : [];
      const migration = read
        ? db.prepare('SELECT id, status, created_at, finished_at FROM migrations WHERE export_id = ? ORDER BY id DESC LIMIT 1').get(read.id)
        : null;
      return {
        id: user.id,
        name: user.name,
        firstSeenAt: user.created_at,
        targetAuthorized: Boolean(accountOf(user.id, 'target')),
        read: read && {
          status: read.status,
          createdAt: read.created_at,
          total: nodes.length,
          failed: nodes.filter((node) => node.status === 'failed').length,
        },
        migration: migration && {
          status: migration.status,
          createdAt: migration.created_at,
          finishedAt: migration.finished_at,
          counts: countItems(db.prepare('SELECT status FROM migration_items WHERE migration_id = ?').all(migration.id)),
        },
      };
    });
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function redirect(res, location, cookies = []) {
  res.writeHead(302, { Location: location, 'Set-Cookie': cookies, 'Cache-Control': 'no-store' });
  res.end();
}

async function readJson(req) {
  // Requiring a JSON content type stops other web pages from posting here via plain forms.
  if (!req.headers['content-type']?.includes('application/json')) throw new Error('需要 JSON 请求');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求太大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0) cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return cookies;
}

// Lax, not Strict: the browser has to send these when Lark redirects back after authorizing.
function cookie(name, value, maxAgeSeconds) {
  const secure = publicUrl().startsWith('https://') ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

const sessionCookie = ({ token, expiresAt }) => cookie(SESSION_COOKIE, token, Math.floor((expiresAt - Date.now()) / 1000));

function requireActor(req) {
  const actor = readSession(parseCookies(req)[SESSION_COOKIE]);
  if (!actor) throw new HttpError(401, '请先登录');
  return actor;
}

function requireAdmin(req) {
  const actor = requireActor(req);
  if (actor.role !== 'admin') throw new HttpError(403, '只有管理员可以这样做');
  return actor;
}

function requireMember(req) {
  const actor = requireActor(req);
  if (actor.role !== 'member') throw new HttpError(403, '这个操作只面向团队成员');
  return actor;
}

const ownerOf = (actor) => (actor.role === 'admin' ? null : actor.userId);

// Someone else's record answers exactly like a missing one, so ids reveal nothing.
function ownedExport(actor, id) {
  const job = db.prepare('SELECT * FROM exports WHERE id = ?').get(id);
  if (!job || job.owner_id !== ownerOf(actor)) throw new HttpError(404, '记录不存在');
  return job;
}

function ownedMigration(actor, id) {
  const row = db.prepare('SELECT export_id FROM migrations WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, '记录不存在');
  ownedExport(actor, row.export_id);
}

function whoAmI(req) {
  const actor = readSession(parseCookies(req)[SESSION_COOKIE]);
  const base = { adminEnabled: adminEnabled(), memberEnabled: Boolean(process.env.LARK_APP_ID) };
  if (!actor) return { role: null, ...base };
  if (actor.role === 'admin') return { role: 'admin', name: '管理员', ...base };
  return {
    role: 'member',
    name: accountOf(actor.userId, 'source')?.name ?? '',
    target: accountOf(actor.userId, 'target'),
    targetEnabled: memberTargetEnabled(),
    ...base,
  };
}

// The error goes to the page as a fixed code, so a crafted link cannot put words on it.
async function handleOAuthCallback(req, res, url) {
  const clearState = cookie(STATE_COOKIE, '', 0);
  const fail = (code) => redirect(res, `/#/login?error=${code}`, [clearState]);
  const state = url.searchParams.get('state');
  const cookies = parseCookies(req);
  const pending = state && state === cookies[STATE_COOKIE] ? takeOAuthState(state) : null;
  if (!pending) return fail('state');
  if (url.searchParams.get('error')) return fail('denied');
  const code = url.searchParams.get('code');
  if (!code) return fail('failed');

  let result;
  try {
    result = await finishOAuth(pending.side, code);
  } catch (err) {
    console.error('Lark OAuth failed:', err.message);
    return fail('failed');
  }
  if (pending.side === 'source') {
    const userId = upsertMember(result.profile);
    saveAccount(userId, 'source', result.profile, result.tokens);
    endSession(cookies[SESSION_COOKIE]);
    return redirect(res, '/', [clearState, sessionCookie(createSession('member', userId))]);
  }
  // The authorization must land on the account that started it.
  if (readSession(cookies[SESSION_COOKIE])?.userId !== pending.userId) return fail('state');
  saveAccount(pending.userId, 'target', result.profile, result.tokens);
  return redirect(res, '/', [clearState]);
}

async function handleApi(req, res, url) {
  const path = url.pathname;
  let match;
  if (req.method === 'GET' && path === '/api/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && path === '/api/me') return send(res, 200, whoAmI(req));

  if (req.method === 'POST' && path === '/api/auth/admin') {
    const { password } = await readJson(req);
    try {
      checkAdminPassword(password, req.socket.remoteAddress);
    } catch (err) {
      throw new HttpError(401, err.message);
    }
    endSession(parseCookies(req)[SESSION_COOKIE]);
    res.setHeader('Set-Cookie', sessionCookie(createSession('admin')));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && path === '/api/auth/logout') {
    await readJson(req);
    endSession(parseCookies(req)[SESSION_COOKIE]);
    res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && path === '/api/auth/lark/login') {
    if (!process.env.LARK_APP_ID) throw new HttpError(400, '管理员还没有配置 Lark 机器人');
    const { url: location, state } = beginOAuth('source');
    return redirect(res, location, [cookie(STATE_COOKIE, state, 600)]);
  }
  if (req.method === 'GET' && path === '/api/auth/lark/target') {
    const actor = requireMember(req);
    if (!memberTargetEnabled()) throw new HttpError(400, '管理员还没有配置新组织的机器人');
    const { url: location, state } = beginOAuth('target', actor.userId);
    return redirect(res, location, [cookie(STATE_COOKIE, state, 600)]);
  }
  if (req.method === 'GET' && path === '/api/auth/lark/callback') return await handleOAuthCallback(req, res, url);
  if (req.method === 'POST' && path === '/api/auth/lark/target/revoke') {
    const actor = requireMember(req);
    await readJson(req);
    removeAccount(actor.userId, 'target');
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && path === '/api/admin/members') {
    requireAdmin(req);
    return send(res, 200, memberOverview());
  }
  if (req.method === 'POST' && path === '/api/library/export') {
    const actor = requireMember(req);
    await readJson(req);
    return send(res, 201, { id: startLibraryExport(actor.userId) });
  }
  if (req.method === 'GET' && path === '/api/exports') {
    const actor = requireActor(req);
    const jobs = db.prepare('SELECT * FROM exports WHERE owner_id IS ? ORDER BY id DESC').all(ownerOf(actor));
    return send(res, 200, jobs.map(exportSummary));
  }
  if (req.method === 'POST' && path === '/api/exports') {
    requireAdmin(req);
    const { url: link } = await readJson(req);
    return send(res, 201, { id: startExport(link) });
  }
  if (req.method === 'GET' && (match = path.match(/^\/api\/exports\/(\d+)$/))) {
    return send(res, 200, exportDetail(ownedExport(requireActor(req), Number(match[1]))));
  }
  if (req.method === 'POST' && (match = path.match(/^\/api\/exports\/(\d+)\/delete$/))) {
    ownedExport(requireActor(req), Number(match[1]));
    await readJson(req);
    deleteExport(Number(match[1]));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && (match = path.match(/^\/api\/exports\/(\d+)\/resume$/))) {
    ownedExport(requireActor(req), Number(match[1]));
    const { retryFailed } = await readJson(req);
    resumeExport(Number(match[1]), { retryFailed: Boolean(retryFailed) });
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && (match = path.match(/^\/api\/exports\/(\d+)\/pause$/))) {
    ownedExport(requireActor(req), Number(match[1]));
    await readJson(req);
    pauseExport(Number(match[1]));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && (match = path.match(/^\/api\/exports\/(\d+)\/nodes\/(\d+)\/retry$/))) {
    ownedExport(requireActor(req), Number(match[1]));
    await readJson(req);
    retryNode(Number(match[1]), Number(match[2]));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && (match = path.match(/^\/api\/exports\/(\d+)\/migration-preview$/))) {
    const actor = requireAdmin(req);
    ownedExport(actor, Number(match[1]));
    const { url: link } = await readJson(req);
    return send(res, 200, await previewMigration(Number(match[1]), link));
  }
  if (req.method === 'POST' && (match = path.match(/^\/api\/exports\/(\d+)\/migrations$/))) {
    const actor = requireAdmin(req);
    ownedExport(actor, Number(match[1]));
    const { url: link } = await readJson(req);
    return send(res, 201, { id: startMigration(Number(match[1]), link) });
  }
  if (req.method === 'POST' && (match = path.match(/^\/api\/exports\/(\d+)\/library-migration$/))) {
    const actor = requireMember(req);
    ownedExport(actor, Number(match[1]));
    await readJson(req);
    if (!memberTargetEnabled()) throw new HttpError(400, '管理员还没有配置新组织的机器人');
    if (!accountOf(actor.userId, 'target')) throw new HttpError(400, '请先授权新组织');
    return send(res, 201, { id: startLibraryMigration(Number(match[1])) });
  }
  if (req.method === 'POST' && (match = path.match(/^\/api\/migrations\/(\d+)\/pause$/))) {
    ownedMigration(requireActor(req), Number(match[1]));
    await readJson(req);
    pauseMigration(Number(match[1]));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && (match = path.match(/^\/api\/migrations\/(\d+)\/resume$/))) {
    ownedMigration(requireActor(req), Number(match[1]));
    await readJson(req);
    resumeMigration(Number(match[1]));
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: '接口不存在' });
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // no-referrer keeps OAuth codes in the callback URL from reaching any other site.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const file = STATIC_FILES[url.pathname];
    if (!file || req.method !== 'GET') {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': file[1] });
    res.end(readFileSync(join(PUBLIC_DIR, file[0])));
  } catch (err) {
    send(res, err.status ?? 400, { error: err.message });
  }
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  server.listen(PORT, HOST, () => {
    console.log(`Lark 迁移工具已启动: http://${HOST}:${PORT}`);
    if (!adminEnabled()) console.log('未设置 ADMIN_PASSWORD，管理员无法登录');
  });
}

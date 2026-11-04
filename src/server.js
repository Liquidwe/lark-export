import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, parseJson } from './db.js';
import { resumeExport, startExport } from './extract.js';
import { resumeMigration, startMigration } from './migrate.js';

const PORT = Number(process.env.PORT || 4310);
// There is no login, so anything beyond localhost is an explicit choice.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

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

function exportDetail(id) {
  const job = db.prepare('SELECT * FROM exports WHERE id = ?').get(id);
  if (!job) return null;
  const nodes = db
    .prepare(
      `SELECT id, node_token, parent_token, obj_type, node_type, title, depth, status, error, stats, warnings
       FROM nodes WHERE export_id = ? ORDER BY position`,
    )
    .all(id)
    .map((node) => ({ ...node, stats: parseJson(node.stats, {}), warnings: parseJson(node.warnings, []) }));
  const totals = {};
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node.stats)) totals[key] = (totals[key] || 0) + value;
  }
  const migrations = db
    .prepare('SELECT id FROM migrations WHERE export_id = ? ORDER BY id DESC')
    .all(id)
    .map((row) => migrationDetail(row.id));
  return { ...exportSummary(job), nodes, totals, migrations };
}

function migrationDetail(id) {
  const job = db.prepare('SELECT * FROM migrations WHERE id = ?').get(id);
  if (!job) return null;
  const items = db
    .prepare(
      `SELECT i.node_id, i.status, i.error, i.warnings, i.target_node_token, n.title, n.obj_type, n.depth
       FROM migration_items i JOIN nodes n ON n.id = i.node_id
       WHERE i.migration_id = ? ORDER BY n.position`,
    )
    .all(id)
    .map((item) => ({
      ...item,
      warnings: parseJson(item.warnings, []),
      url: item.target_node_token ? `${job.target_host}/wiki/${item.target_node_token}` : null,
    }));
  const counts = { total: items.length, done: 0, failed: 0, placeholder: 0 };
  for (const item of items) {
    if (item.status in counts) counts[item.status]++;
  }
  return { ...job, counts, items };
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  // Requiring a JSON content type stops other local web pages from posting here via plain forms.
  if (!req.headers['content-type']?.includes('application/json')) throw new Error('需要 JSON 请求');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

async function handleApi(req, res, path) {
  let match;
  if (req.method === 'GET' && path === '/api/exports') {
    const jobs = db.prepare('SELECT * FROM exports ORDER BY id DESC').all();
    return send(res, 200, jobs.map(exportSummary));
  }
  if (req.method === 'POST' && path === '/api/exports') {
    const { url } = await readJson(req);
    return send(res, 201, { id: startExport(url) });
  }
  if (req.method === 'GET' && (match = path.match(/^\/api\/exports\/(\d+)$/))) {
    const detail = exportDetail(Number(match[1]));
    return detail ? send(res, 200, detail) : send(res, 404, { error: '记录不存在' });
  }
  if (req.method === 'POST' && (match = path.match(/^\/api\/exports\/(\d+)\/resume$/))) {
    await readJson(req);
    resumeExport(Number(match[1]));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && (match = path.match(/^\/api\/exports\/(\d+)\/migrations$/))) {
    const { url } = await readJson(req);
    return send(res, 201, { id: startMigration(Number(match[1]), url) });
  }
  if (req.method === 'POST' && (match = path.match(/^\/api\/migrations\/(\d+)\/resume$/))) {
    await readJson(req);
    resumeMigration(Number(match[1]));
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: '接口不存在' });
}

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (path.startsWith('/api/')) return await handleApi(req, res, path);
    const file = STATIC_FILES[path];
    if (!file || req.method !== 'GET') {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': file[1] });
    res.end(readFileSync(join(PUBLIC_DIR, file[0])));
  } catch (err) {
    send(res, 400, { error: err.message });
  }
}).listen(PORT, HOST, () => {
  console.log(`Lark 迁移工具已启动: http://${HOST}:${PORT}`);
});

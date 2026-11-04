import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'lark-export-pause-'));
process.env.DATA_DIR = dataDir;
process.env.LARK_APP_ID = 'a';
process.env.LARK_APP_SECRET = 's';
process.env.READ_CONCURRENCY = '2';
const { db } = await import('../src/db.js');
const { pauseExport, resumeExport, retryNode } = await import('../src/extract.js');
const { pauseMigration, resumeMigration, startMigration } = await import('../src/migrate.js');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const API = 'https://example.test/open-apis';

// Answers docx reads, failing any object in `broken` with an API error.
function stubLark({ broken = new Set(), delay = 20 } = {}) {
  const reads = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    }
    const obj = url.pathname.match(/documents\/([^/]+)\/blocks/)?.[1];
    reads.push(obj);
    await sleep(delay);
    if (broken.has(obj)) return Response.json({ code: 1770002, msg: 'boom' });
    return Response.json({ code: 0, data: { items: [{ block_id: 'p', block_type: 1 }], has_more: false } });
  };
  return reads;
}

// Seeds a read whose tree is known, so runs start at the content phase.
function seedExport(count, status = 'paused') {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO exports (source_url, host, api_base, root_token, status, tree_complete, created_at)
       VALUES ('x', 'https://src.test', ?, 'n0', ?, 1, 0)`,
    )
    .run(API, status);
  const id = Number(lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO nodes (export_id, node_token, parent_token, obj_token, obj_type, node_type, title, depth, position)
     VALUES (?, ?, ?, ?, 'docx', 'origin', ?, ?, ?)`,
  );
  for (let i = 0; i < count; i++) {
    insert.run(id, `n${i}`, i ? 'n0' : null, `obj${id}-${i}`, `doc${i}`, i ? 1 : 0, i);
  }
  return id;
}

const statusOf = (id) => db.prepare('SELECT status FROM exports WHERE id = ?').get(id).status;
const nodeCounts = (id) =>
  Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM nodes WHERE export_id = ? GROUP BY status').all(id).map((r) => [r.status, r.n]),
  );

async function until(check, label) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('pause stops new reads, keeps finished work, and continue reads each node once', async () => {
  const reads = stubLark();
  const id = seedExport(12);
  resumeExport(id);
  await until(() => (nodeCounts(id).done || 0) >= 2, 'some nodes to finish');
  pauseExport(id);
  assert.equal(statusOf(id), 'pausing');
  assert.throws(() => resumeExport(id), /进行中/, 'cannot continue until in-flight work drains');

  await until(() => statusOf(id) === 'paused', 'the run to settle');
  const paused = nodeCounts(id);
  assert.ok(paused.pending > 0, 'some nodes are left');
  assert.equal(paused.reading, undefined, 'nothing is still in flight');
  const readsAtPause = reads.length;
  await sleep(60);
  assert.equal(reads.length, readsAtPause, 'no reads happen while paused');

  resumeExport(id);
  await until(() => statusOf(id) === 'done', 'the read to finish');
  assert.deepEqual(nodeCounts(id), { done: 12 });
  assert.equal(new Set(reads).size, 12);
  assert.equal(reads.length, 12, 'no node was read twice');
});

test('a failed node is retried alone, and the job settles when it succeeds', async () => {
  const broken = new Set();
  const reads = stubLark({ broken });
  const id = seedExport(4);
  broken.add(`obj${id}-2`);
  resumeExport(id);
  await until(() => statusOf(id) === 'partial', 'the read to finish');
  assert.deepEqual(nodeCounts(id), { done: 3, failed: 1 });
  const node = db.prepare(`SELECT * FROM nodes WHERE export_id = ? AND status = 'failed'`).get(id);
  assert.match(node.error, /boom/);

  // Still broken: it fails again and the job stays partial.
  retryNode(id, node.id);
  await until(() => nodeCounts(id).failed === 1 && !nodeCounts(id).reading, 'the retry to fail');
  assert.equal(statusOf(id), 'partial');

  broken.clear();
  const before = reads.length;
  retryNode(id, node.id);
  assert.equal(db.prepare('SELECT status FROM nodes WHERE id = ?').get(node.id).status, 'reading');
  assert.throws(() => retryNode(id, node.id), /只有读取失败/, 'a node cannot be retried twice at once');
  await until(() => statusOf(id) === 'done', 'the job to settle');
  assert.equal(reads.length, before + 1, 'only that node was read');
  const done = db.prepare('SELECT status, error FROM nodes WHERE id = ?').get(node.id);
  assert.deepEqual({ ...done }, { status: 'done', error: null });
});

test('retrying a node on a paused job does not finish the job or read the others', async () => {
  const reads = stubLark();
  const id = seedExport(3);
  const [failed] = db.prepare('SELECT id, obj_token FROM nodes WHERE export_id = ? ORDER BY position').all(id);
  db.prepare(`UPDATE nodes SET status = 'failed', error = 'old' WHERE id = ?`).run(failed.id);
  retryNode(id, failed.id);
  await until(() => nodeCounts(id).done === 1, 'the retry to finish');
  await sleep(20);
  assert.equal(statusOf(id), 'paused');
  assert.deepEqual(reads, [failed.obj_token]);
});

test('continue leaves failed nodes alone unless asked to retry them', async () => {
  const broken = new Set();
  const reads = stubLark({ broken });
  const id = seedExport(3);
  const nodes = db.prepare('SELECT id, obj_token FROM nodes WHERE export_id = ? ORDER BY position').all(id);
  db.prepare(`UPDATE nodes SET status = 'failed', error = 'old' WHERE id = ?`).run(nodes[0].id);

  resumeExport(id);
  await until(() => statusOf(id) === 'partial', 'the run to end');
  assert.ok(!reads.includes(nodes[0].obj_token));

  resumeExport(id, { retryFailed: true });
  await until(() => statusOf(id) === 'done', 'the retry to finish');
  assert.ok(reads.includes(nodes[0].obj_token));
});

test('pausing a job that is not running is refused', () => {
  const id = seedExport(1);
  assert.throws(() => pauseExport(id), /没有在进行中/);
});

test('migration is refused while nodes are still unread', () => {
  const id = seedExport(2);
  db.prepare(`UPDATE exports SET status = 'paused' WHERE id = ?`).run(id);
  assert.throws(() => startMigration(id, 'https://dst.larksuite.com/wiki/target'), /没有读取完/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migrations WHERE export_id = ?').get(id).n, 0);
});

test('migration pauses before the next node and continues without recreating finished ones', async () => {
  const created = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    }
    if (url.pathname.endsWith('/get_node')) {
      return Response.json({ code: 0, data: { node: { space_id: 'sp', node_token: 'target' } } });
    }
    if (url.pathname.endsWith('/nodes') && init.method === 'POST') {
      const { title } = JSON.parse(init.body);
      created.push(title);
      await sleep(30);
      const token = `new-${created.length}`;
      return Response.json({ code: 0, data: { node: { node_token: token, obj_token: `o${token}`, obj_type: 'docx' } } });
    }
    return Response.json({ code: 0, data: { block: { children: [] } } });
  };

  const id = seedExport(5, 'done');
  db.prepare(`UPDATE nodes SET status = 'done', content = ?, stats = '{}', warnings = '[]' WHERE export_id = ?`).run(
    JSON.stringify({ blocks: [{ block_id: 'p', block_type: 1, children: [] }] }),
    id,
  );
  const migrationId = startMigration(id, 'https://dst.larksuite.com/wiki/target');
  const statusM = () => db.prepare('SELECT status FROM migrations WHERE id = ?').get(migrationId).status;
  await until(() => created.length >= 2, 'some nodes to be created');
  pauseMigration(migrationId);
  assert.throws(() => resumeMigration(migrationId), /进行中/);
  await until(() => statusM() === 'paused', 'the migration to settle');
  const atPause = created.length;
  assert.ok(atPause < 5);
  await sleep(60);
  assert.equal(created.length, atPause, 'nothing is created while paused');

  resumeMigration(migrationId);
  await until(() => statusM() === 'done', 'the migration to finish');
  assert.deepEqual(created, ['doc0', 'doc1', 'doc2', 'doc3', 'doc4'], 'each node created once, in order');
});

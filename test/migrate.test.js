import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'lark-export-migrate-'));
process.env.DATA_DIR = dataDir;
process.env.LARK_APP_ID = 'a';
process.env.LARK_APP_SECRET = 's';
const { db } = await import('../src/db.js');
const { previewMigration, startMigration } = await import('../src/migrate.js');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TARGET_URL = 'https://dst.larksuite.com/wiki/target';
const DOC = JSON.stringify({ blocks: [{ block_id: 'p', block_type: 1, children: [] }] });

// Seeds a read of: root > child > grandchild.
function seedExport(rootType = 'docx') {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO exports (source_url, host, api_base, root_token, status, tree_complete, created_at)
       VALUES ('x', 'https://src.test', 'https://example.test', 'root', 'done', 1, 0)`,
    )
    .run();
  const id = Number(lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO nodes (export_id, node_token, parent_token, obj_token, obj_type, node_type, title, depth, position, status, content, stats, warnings)
     VALUES (?, ?, ?, ?, ?, 'origin', ?, ?, ?, 'done', ?, '{}', '[]')`,
  );
  insert.run(id, 'root', null, 'o-root', rootType, 'Kili-AI', 0, 0, rootType === 'docx' ? DOC : JSON.stringify({ tables: [] }));
  insert.run(id, 'child', 'root', 'o-child', 'docx', '1. 目标', 1, 1, DOC);
  insert.run(id, 'grand', 'child', 'o-grand', 'docx', '1.1 细节', 2, 2, DOC);
  return id;
}

// A fake Lark holding one target doc. Records writes so tests can assert on them.
function stubLark({ targetType = 'docx', body = [], children = [] } = {}) {
  const log = { created: [], titles: [], cleared: [], written: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const ok = (data) => Response.json({ code: 0, data });
    if (path.endsWith('tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    }
    if (path.endsWith('/get_node')) {
      return ok({ node: { space_id: 'sp', node_token: 'target', obj_token: 'o-target', obj_type: targetType, title: '33', has_child: children.length > 0 } });
    }
    if (path.endsWith('/update_title')) {
      log.titles.push([path.split('/').at(-2), JSON.parse(init.body).title]);
      return ok({});
    }
    if (path.endsWith('/nodes') && init.method === 'POST') {
      const { parent_node_token: parent, title, obj_type: type } = JSON.parse(init.body);
      log.created.push({ parent, title });
      const token = `new-${log.created.length}`;
      return ok({ node: { node_token: token, obj_token: `o-${token}`, obj_type: type } });
    }
    if (path.endsWith('/nodes')) return ok({ items: children, has_more: false });
    if (path.endsWith('/batch_delete')) {
      log.cleared.push(path.match(/documents\/([^/]+)/)[1]);
      return ok({});
    }
    if (path.endsWith('/descendant')) {
      log.written.push(path.match(/documents\/([^/]+)/)[1]);
      return ok({ block_id_relations: [] });
    }
    if (path.endsWith('/blocks')) return ok({ items: body, has_more: false });
    if (/\/blocks\/[^/]+$/.test(path)) return ok({ block: { children: path.includes('o-target') ? ['x'] : [] } });
    return ok({ items: [], has_more: false });
  };
  return log;
}

async function finished(id) {
  for (let i = 0; i < 300; i++) {
    const job = db.prepare('SELECT * FROM migrations WHERE id = ?').get(id);
    if (!['running', 'pausing'].includes(job.status)) return job;
    await sleep(20);
  }
  assert.fail('migration did not finish');
}

const items = (id) =>
  db.prepare(
    `SELECT n.title, i.target_node_token AS token, i.status, i.warnings FROM migration_items i JOIN nodes n ON n.id = i.node_id
     WHERE i.migration_id = ? ORDER BY n.position`,
  ).all(id);

test('the target becomes the source root: renamed, not nested, with children directly under it', async () => {
  const log = stubLark();
  const id = startMigration(seedExport(), TARGET_URL);
  const job = await finished(id);
  assert.equal(job.status, 'done', job.error);

  assert.deepEqual(log.titles, [['target', 'Kili-AI']]);
  assert.deepEqual(log.created, [
    { parent: 'target', title: '1. 目标' },
    { parent: 'new-1', title: '1.1 细节' },
  ]);
  assert.equal(items(id)[0].token, 'target');
  assert.ok(log.cleared.includes('o-target'), 'the target body is replaced, not appended to');
});

test('a source root that is not a doc cannot merge, so it goes under the target and says so', async () => {
  const log = stubLark();
  const id = startMigration(seedExport('bitable'), TARGET_URL);
  const job = await finished(id);
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(log.titles, []);
  assert.deepEqual(log.created[0], { parent: 'target', title: 'Kili-AI' });
  assert.match(items(id)[0].warnings, /无法合并/);
});

test('a target that is not a doc is left untouched', async () => {
  const log = stubLark({ targetType: 'sheet' });
  const job = await finished(startMigration(seedExport(), TARGET_URL));
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(log.titles, []);
  assert.deepEqual(log.cleared.filter((doc) => doc === 'o-target'), []);
  assert.equal(log.created[0].title, 'Kili-AI');
});

test('a target inside the source tree is refused before anything is written', async () => {
  const log = stubLark();
  const id = seedExport();
  for (const token of ['root', 'grand']) {
    const url = `https://dst.larksuite.com/wiki/${token}`;
    assert.throws(() => startMigration(id, url), /源目录/);
    await assert.rejects(previewMigration(id, url), /源目录/);
  }
  assert.deepEqual(log, { created: [], titles: [], cleared: [], written: [] });
});

test('preview reports what would be overwritten, ignoring the empty line of a new doc', async () => {
  const id = seedExport();
  stubLark({
    body: [
      { block_type: 1 },
      { block_type: 2, text: { elements: [{ text_run: { content: '' } }] } },
      { block_type: 2, text: { elements: [{ text_run: { content: '已有内容' } }] } },
      { block_type: 22 },
    ],
    children: [{ node_token: 'old' }],
  });
  const preview = await previewMigration(id, TARGET_URL);
  assert.equal(preview.overwrite, true);
  assert.equal(preview.targetTitle, '33');
  assert.equal(preview.rootTitle, 'Kili-AI');
  assert.equal(preview.bodyBlocks, 2);
  assert.equal(preview.childCount, 1);
});

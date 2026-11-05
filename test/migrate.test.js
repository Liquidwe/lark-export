import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'lark-export-migrate-'));
process.env.DATA_DIR = dataDir;
process.env.LARK_APP_ID = 'a';
process.env.LARK_APP_SECRET = 's';
process.env.WRITE_CONCURRENCY = '3';
const { db } = await import('../src/db.js');
const { migrationProgress, previewMigration, resumeMigration, startMigration } = await import('../src/migrate.js');

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
function stubLark({ targetType = 'docx', body = [], children = [], dropTitleUpdates = 0 } = {}) {
  const log = { created: [], titles: [], cleared: [], written: [] };
  let title = '33';
  let dropRenames = dropTitleUpdates;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const ok = (data) => Response.json({ code: 0, data });
    if (path.endsWith('tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    }
    if (path.endsWith('/get_node')) {
      return ok({ node: { space_id: 'sp', node_token: 'target', obj_token: 'o-target', obj_type: targetType, title, has_child: children.length > 0 } });
    }
    if (path.endsWith('/update_title')) {
      log.titles.push([path.split('/').at(-2), JSON.parse(init.body).title]);
      if (dropRenames-- <= 0) title = JSON.parse(init.body).title;
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
  for (let i = 0; i < 1000; i++) {
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

// root > a, b; a > a1, a2, a3; b > b1, b2, b3
function seedBranches() {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO exports (source_url, host, api_base, root_token, status, tree_complete, created_at)
       VALUES ('x', 'https://src.test', 'https://example.test', 'root', 'done', 1, 0)`,
    )
    .run();
  const id = Number(lastInsertRowid);
  const body = JSON.stringify({
    blocks: [
      { block_id: 'p', block_type: 1, children: ['t'] },
      { block_id: 't', block_type: 2, text: { elements: [{ text_run: { content: '正文' } }] } },
    ],
  });
  const insert = db.prepare(
    `INSERT INTO nodes (export_id, node_token, parent_token, obj_token, obj_type, node_type, title, depth, position, status, content, stats, warnings)
     VALUES (?, ?, ?, ?, 'docx', 'origin', ?, ?, ?, 'done', ?, '{}', '[]')`,
  );
  const tree = [['root', null, 0], ['a', 'root', 1], ['a1', 'a', 2], ['a2', 'a', 2], ['a3', 'a', 2], ['b', 'root', 1], ['b1', 'b', 2], ['b2', 'b', 2], ['b3', 'b', 2]];
  tree.forEach(([token, parent, depth], position) => insert.run(id, `${id}-${token}`, parent && `${id}-${parent}`, `o-${token}`, token, depth, position, body));
  return id;
}

// A fake Lark slower than the client's throttle, which would otherwise keep calls from overlapping.
function stubSlowLark({ failDoc } = {}) {
  let title = '33';
  const seen = { order: new Map(), maxBranches: 0, maxDocs: 0, maxPerDoc: 0 };
  const inflight = { parents: new Map(), docs: new Map() };
  const peak = (map, key) => {
    map.set(key, (map.get(key) ?? 0) + 1);
    return () => map.set(key, map.get(key) - 1);
  };
  const open = (map) => [...map.values()].filter(Boolean).length;
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    const ok = (data) => Response.json({ code: 0, data });
    if (path.endsWith('tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    if (path.endsWith('/get_node')) return ok({ node: { space_id: 'sp', node_token: 'target', obj_token: 'o-target', obj_type: 'docx', title } });
    if (path.endsWith('/update_title')) {
      title = JSON.parse(init.body).title;
      return ok({});
    }
    if (path.endsWith('/nodes') && init.method === 'POST') {
      const { parent_node_token: parent, title } = JSON.parse(init.body);
      seen.order.set(parent, [...(seen.order.get(parent) ?? []), title]);
      const done = peak(inflight.parents, parent);
      seen.maxBranches = Math.max(seen.maxBranches, open(inflight.parents));
      assert.ok(inflight.parents.get(parent) <= 1, 'siblings overlap, which would scramble their order');
      await sleep(500);
      done();
      return ok({ node: { node_token: `n-${title}`, obj_token: `d-${title}`, obj_type: 'docx' } });
    }
    const doc = path.match(/documents\/([^/]+)/)?.[1];
    if (doc) {
      const done = peak(inflight.docs, doc);
      seen.maxDocs = Math.max(seen.maxDocs, open(inflight.docs));
      seen.maxPerDoc = Math.max(seen.maxPerDoc, inflight.docs.get(doc));
      await sleep(500);
      done();
      if (doc === failDoc?.value && path.endsWith('/descendant')) return Response.json({ code: 1770002, msg: 'boom' });
      return ok({ block: { children: [] }, block_id_relations: [] });
    }
    return ok({});
  };
  return seen;
}

test('documents and separate branches run at once, while siblings and each document stay in order', async () => {
  const seen = stubSlowLark();
  const job = await finished(startMigration(seedBranches(), TARGET_URL));
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(seen.order.get('target'), ['a', 'b']);
  assert.deepEqual(seen.order.get('n-a'), ['a1', 'a2', 'a3']);
  assert.deepEqual(seen.order.get('n-b'), ['b1', 'b2', 'b3']);
  assert.ok(seen.maxBranches > 1, 'separate parents should overlap');
  assert.ok(seen.maxDocs > 1, 'documents should overlap');
  assert.ok(seen.maxDocs <= 3, `at most WRITE_CONCURRENCY documents, saw ${seen.maxDocs}`);
  assert.equal(seen.maxPerDoc, 1, 'one document is never written by two workers');
});

test('progress shows the phase, what is in flight and the time spent, then settles', async () => {
  stubSlowLark();
  const id = startMigration(seedBranches(), TARGET_URL);
  const detail = () => {
    const job = db.prepare('SELECT * FROM migrations WHERE id = ?').get(id);
    const rows = db
      .prepare(
        `SELECT i.node_id, i.status, i.target_node_token, n.title, n.obj_type FROM migration_items i
         JOIN nodes n ON n.id = i.node_id WHERE i.migration_id = ?`,
      )
      .all(id);
    return { job, progress: migrationProgress(job, rows) };
  };

  let sawStructure;
  let sawContent;
  for (let i = 0; i < 2000 && !sawContent; i++) {
    const { job, progress } = detail();
    if (job.phase === 'structure' && progress.active.length) sawStructure = progress;
    if (job.phase === 'content' && progress.active.some((a) => a.step === '写入正文')) sawContent = progress;
    await sleep(5);
  }
  assert.equal(sawStructure.active[0].step, '新建节点');
  assert.ok(sawStructure.active[0].title);
  const writing = sawContent.active.find((a) => a.step === '写入正文');
  assert.deepEqual([writing.done, writing.total], [0, 1]);
  assert.equal(sawContent.structure, 9);

  await finished(id);
  await sleep(10);
  const { progress } = detail();
  assert.equal(progress.content, 9);
  assert.deepEqual(progress.byType, { docx: { total: 9, done: 9 } });
  assert.deepEqual(progress.active, []);
  assert.equal(progress.etaMs, null);
  assert.ok(progress.elapsedMs > 0);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM migration_items WHERE migration_id = ? AND duration_ms > 0').get(id);
  assert.equal(n, 9, 'every node records its time');
});

test('retrying puts failed documents back in line instead of showing them as finished', async () => {
  const failDoc = { value: 'd-a2' };
  stubSlowLark({ failDoc });
  const id = startMigration(seedBranches(), TARGET_URL);
  const job = await finished(id);
  assert.equal(job.status, 'partial');
  const status = () => db.prepare(`SELECT COUNT(*) AS n FROM migration_items WHERE migration_id = ? AND status = 'failed'`).get(id).n;
  assert.equal(status(), 1);

  failDoc.value = null;
  resumeMigration(id);
  assert.equal(status(), 0, 'not failed while waiting for its retry');
  assert.equal((await finished(id)).status, 'done');
});

test('a rename Lark drops is noticed by reading the title back, and sent again', async () => {
  const log = stubLark({ dropTitleUpdates: 1 });
  const id = startMigration(seedExport(), TARGET_URL);
  const job = await finished(id);
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(log.titles.map(([, title]) => title), ['Kili-AI', 'Kili-AI…', 'Kili-AI']);
  assert.equal(items(id)[0].warnings, '[]');
});

test('a rename that never lands warns on the root rather than passing silently', async () => {
  const log = stubLark({ dropTitleUpdates: 100 });
  const id = startMigration(seedExport(), TARGET_URL);
  const job = await finished(id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(log.titles.length, 11, 'the first rename plus five retries of two steps');
  assert.match(items(id)[0].warnings, /手动修改标题/);
});

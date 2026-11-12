import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'lark-export-repair-'));
process.env.DATA_DIR = dataDir;
process.env.LARK_APP_ID = 'a';
process.env.LARK_APP_SECRET = 's';
const { db } = await import('../src/db.js');
const { applyRepair, listRepairs, matchByTitle, startRepair } = await import('../src/repair.js');
const { writeDocx } = await import('../src/docx-writer.js');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (data) => Response.json({ code: 0, data });

const diagram = (id, source) => ({
  block_id: id,
  block_type: 40,
  add_ons: { component_type_id: 'blk_mermaid', record: JSON.stringify({ data: source, theme: 'default', view: 'chart' }) },
});
const line = (id, content) => ({ block_id: id, block_type: 2, text: { elements: [{ text_run: { content } }] } });
const placeholder = (id) => line(id, '[未迁移的内容: 扩展组件]');
const page = (id, children) => ({ block_id: id, block_type: 1, children });

// Source tree: root > A, B, C, D. The target was migrated before diagrams were supported.
function fakeLark() {
  const docs = {
    'o-root': [page('o-root', ['d0']), diagram('d0', 'graph TD; R')],
    'o-a': [page('o-a', ['t', 'd1', 'c']), line('t', '正文'), diagram('d1', 'graph TD; A1'), { block_id: 'c', block_type: 19, callout: {}, children: ['d2'] }, diagram('d2', 'graph TD; A2')],
    'o-b': [page('o-b', ['d3']), diagram('d3', 'graph TD; B')],
    'o-c': [page('o-c', ['x']), line('x', '没有图')],
    'o-d': [page('o-d', ['d4']), diagram('d4', 'graph TD; D')],
    // Already restored by hand, so nothing to do.
    'n-root': [page('n-root', ['e0']), diagram('e0', 'graph TD; R')],
    'n-a': [page('n-a', ['t', 'p1', 'c']), line('t', '正文'), placeholder('p1'), { block_id: 'c', block_type: 19, callout: {}, children: ['p2'] }, placeholder('p2')],
    // Someone added a diagram after migrating, so positions no longer line up.
    'n-b': [page('n-b', ['p3', 'extra']), placeholder('p3'), diagram('extra', 'graph TD; new')],
    'n-c': [page('n-c', ['x']), line('x', '没有图')],
  };
  const tree = {
    src: { node: { space_id: 's', node_token: 'src', obj_token: 'o-root', obj_type: 'docx', title: '总览', has_child: true } },
    dst: { node: { space_id: 't', node_token: 'dst', obj_token: 'n-root', obj_type: 'docx', title: '总览', has_child: true } },
  };
  const kids = {
    src: ['A', 'B', 'C', 'D'].map((t) => ({ space_id: 's', node_token: `s-${t}`, obj_token: `o-${t.toLowerCase()}`, obj_type: 'docx', title: t, has_child: false })),
    dst: ['C', 'A', 'B'].map((t) => ({ space_id: 't', node_token: `t-${t}`, obj_token: `n-${t.toLowerCase()}`, obj_type: 'docx', title: t, has_child: false })),
  };
  const writes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/open-apis', '');
    if (path.endsWith('tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    if (path.endsWith('/get_node')) return ok(tree[url.searchParams.get('token')]);
    const parent = url.searchParams.get('parent_node_token');
    if (path.endsWith('/nodes') && parent) return ok({ items: kids[parent] ?? [], has_more: false });
    const doc = path.match(/documents\/([^/]+)\/blocks/)?.[1];
    if (init.method === 'POST' && path.endsWith('/descendant')) {
      const body = JSON.parse(init.body);
      const parentId = path.match(/blocks\/([^/]+)\/descendant/)[1];
      writes.push({ op: 'insert', doc, parentId, index: body.index, block: body.descendants[0] });
      const holder = docs[doc].find((b) => b.block_id === parentId);
      holder.children.splice(body.index, 0, `new-${writes.length}`);
      docs[doc].push({ ...body.descendants[0], block_id: `new-${writes.length}` });
      return ok({ block_id_relations: [] });
    }
    if (init.method === 'DELETE') {
      const body = JSON.parse(init.body);
      const parentId = path.match(/blocks\/([^/]+)\/children/)[1];
      writes.push({ op: 'delete', doc, parentId, start: body.start_index, end: body.end_index });
      docs[doc].find((b) => b.block_id === parentId).children.splice(body.start_index, body.end_index - body.start_index);
      return ok({});
    }
    if (doc) return ok({ items: docs[doc], has_more: false });
    return ok({ items: [], has_more: false });
  };
  return { docs, writes };
}

async function until(id, statuses) {
  for (let i = 0; i < 500; i++) {
    const job = listRepairs().find((r) => r.id === id);
    if (statuses.includes(job.status)) return job;
    await sleep(10);
  }
  assert.fail('repair did not finish');
}

const SOURCE = 'https://old.larksuite.com/wiki/src';
const TARGET = 'https://new.larksuite.com/wiki/dst';

test('comparing lists what is missing and writes nothing', async () => {
  const { writes } = fakeLark();
  const id = startRepair(SOURCE, TARGET);
  const job = await until(id, ['scanned', 'failed']);
  assert.equal(job.error, null);
  assert.deepEqual(
    job.docs.map((d) => [d.path, d.state, d.diagrams, d.missing]),
    [
      ['总览', 'complete', 1, 0],
      ['总览 / A', 'missing', 2, 2],
      ['总览 / B', 'mismatch', 1, 1],
    ],
  );
  assert.deepEqual(job.progress.unmatched, ['总览 / D']);
  assert.equal(job.docs[1].targetUrl, 'https://new.larksuite.com/wiki/t-A');
  assert.equal(writes.length, 0);
});

test('applying puts each diagram where its placeholder was, and leaves documents that do not line up', async () => {
  const { docs, writes } = fakeLark();
  const id = startRepair(SOURCE, TARGET);
  await until(id, ['scanned']);
  applyRepair(id);
  const job = await until(id, ['done', 'partial', 'failed']);
  assert.equal(job.status, 'done', JSON.stringify(job.docs.map((d) => [d.path, d.state, d.error])));

  assert.ok(writes.every((w) => w.doc === 'n-a'), 'only the document that lines up is touched');
  assert.deepEqual(
    writes.map((w) => (w.op === 'insert' ? [w.op, w.parentId, w.index, JSON.parse(w.block.add_ons.record).data] : [w.op, w.parentId, w.start, w.end])),
    [
      ['insert', 'n-a', 1, 'graph TD; A1'],
      ['delete', 'n-a', 2, 3],
      ['insert', 'c', 0, 'graph TD; A2'],
      ['delete', 'c', 1, 2],
    ],
  );
  const byId = new Map(docs['n-a'].map((b) => [b.block_id, b]));
  assert.deepEqual(byId.get('n-a').children.map((child) => byId.get(child).block_type), [2, 40, 19]);
  assert.deepEqual(byId.get('c').children.map((child) => byId.get(child).block_type), [40]);
  assert.equal(writes[0].block.add_ons.component_type_id, 'blk_mermaid');

  const a = job.docs.find((d) => d.path === '总览 / A');
  assert.deepEqual([a.state, a.restored, a.missing], ['fixed', 2, 0]);
  assert.equal(job.docs.find((d) => d.path === '总览 / B').state, 'mismatch');
  assert.throws(() => applyRepair(id), /请等对比完成|没有需要补全/);
});

test('children with the same title pair up in order', () => {
  const pairs = matchByTitle(
    [{ title: 'x', n: 1 }, { title: 'x', n: 2 }, { title: 'y', n: 3 }],
    [{ title: 'x', n: 'a' }, { title: 'z' }, { title: 'x', n: 'b' }],
  );
  assert.deepEqual(pairs.map((p) => [p.source.n, p.target?.n ?? null]), [[1, 'a'], [2, 'b'], [3, null]]);
});

test('migrating copies a Mermaid diagram as the same extension block', async () => {
  const calls = [];
  const client = {
    get: async () => ({ block: { children: [] } }),
    post: async (path, body) => {
      calls.push(body);
      return { block_id_relations: [] };
    },
    request: async () => ({}),
  };
  const warnings = [];
  await writeDocx({
    client,
    documentId: 'T',
    content: { blocks: [page('doc', ['m']), diagram('m', 'graph TD; X')] },
    assets: new Map(),
    linkFor: () => null,
    warn: (w) => warnings.push(w),
  });
  const [created] = calls[0].descendants;
  assert.deepEqual(created, {
    block_id: 'm',
    block_type: 40,
    add_ons: { component_type_id: 'blk_mermaid', record: diagram('m', 'graph TD; X').add_ons.record },
  });
  assert.deepEqual(warnings, []);
});

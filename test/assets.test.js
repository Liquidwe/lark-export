import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'lark-export-assets-'));
process.env.DATA_DIR = dataDir;
process.env.LARK_APP_ID = 'a';
process.env.LARK_APP_SECRET = 's';
const { db } = await import('../src/db.js');
const { writeBitable } = await import('../src/bitable-writer.js');
const { writeDocx } = await import('../src/docx-writer.js');
const { resumeExport } = await import('../src/extract.js');
const { startMigration } = await import('../src/migrate.js');

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
const ok = (data) => Response.json({ code: 0, data });
const THIS_FILE = new URL(import.meta.url).pathname;

async function settled(table, id) {
  for (let i = 0; i < 500; i++) {
    const row = db.prepare(`SELECT status, error FROM ${table} WHERE id = ?`).get(id);
    if (!['running', 'pausing'].includes(row.status)) return row;
    await sleep(10);
  }
  assert.fail(`${table} ${id} did not finish`);
}

function seedExport(objType, status = 'paused') {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO exports (source_url, host, api_base, root_token, status, tree_complete, created_at)
       VALUES ('x', 'https://src.test', ?, 'n0', ?, 1, 0)`,
    )
    .run(API, status);
  const id = Number(lastInsertRowid);
  db.prepare(
    `INSERT INTO nodes (export_id, node_token, parent_token, obj_token, obj_type, node_type, title, depth, position)
     VALUES (?, 'n0', NULL, 'obj', ?, 'origin', '有素材的文档', 0, 0)`,
  ).run(id, objType);
  return id;
}

const nodeOf = (id) => {
  const node = db.prepare('SELECT * FROM nodes WHERE export_id = ?').get(id);
  return { ...node, stats: JSON.parse(node.stats ?? '{}'), warnings: JSON.parse(node.warnings ?? '[]'), content: JSON.parse(node.content ?? 'null') };
};

// Lark refuses a download either with an empty 404 or with a JSON error, depending on why.
function refuse(token) {
  if (token === 'video') return new Response(null, { status: 404 });
  if (token === 'deck') return Response.json({ code: 1062501, msg: 'no download permission' }, { status: 403 });
  return null;
}

test('reading: refused files are skipped and named, and everything else in the document is kept', async () => {
  const blocks = [
    { block_id: 'p', block_type: 1, children: ['t', 'ok', 'v', 'd', 'b'] },
    { block_id: 't', block_type: 2, text: { elements: [{ text_run: { content: '正文' } }] } },
    { block_id: 'ok', block_type: 27, image: { token: 'photo' } },
    { block_id: 'v', block_type: 23, file: { token: 'video', name: '培训.mp4' } },
    { block_id: 'd', block_type: 23, file: { token: 'deck', name: '方案.pptx' } },
    { block_id: 'b', block_type: 43, board: { token: 'board' } },
  ];
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    const media = path.match(/medias\/([^/]+)\/download/)?.[1];
    if (media) return refuse(media) ?? new Response('bytes', { headers: { 'content-type': 'image/png' } });
    if (path.includes('/whiteboards/')) return ok({ nodes: [{ id: 'n', type: 'image', image: { token: 'video' } }] });
    return ok({ items: blocks, has_more: false });
  };
  const id = seedExport('docx');
  resumeExport(id);
  await settled('exports', id);

  const node = nodeOf(id);
  assert.equal(node.status, 'done', node.error);
  assert.equal(node.content.blocks.length, blocks.length);
  assert.equal(node.stats.images, 1);
  assert.equal(node.stats.files, 0);
  assert.equal(node.stats.skipped, 3);
  assert.equal(node.warnings.filter((w) => w.includes('培训.mp4')).length, 1);
  assert.equal(node.warnings.filter((w) => w.includes('方案.pptx')).length, 1);
  assert.equal(node.warnings.filter((w) => w.includes('画板中的图片')).length, 1);
  assert.deepEqual(
    db.prepare('SELECT kind, token FROM assets WHERE export_id = ?').all(id).map((a) => ({ ...a })),
    [{ kind: 'image', token: 'photo' }],
  );
});

test('reading: a bitable keeps its records when an attachment is refused', async () => {
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    if (path.includes('/medias/')) return refuse('video');
    if (path.endsWith('/tables')) return ok({ items: [{ table_id: 'tb', name: '表' }], has_more: false });
    if (path.endsWith('/fields')) return ok({ items: [{ field_name: '附件', type: 17 }], has_more: false });
    if (path.endsWith('/records')) {
      return ok({ items: [{ record_id: 'r', fields: { 附件: [{ file_token: 'video', name: '培训.mp4' }] } }], has_more: false });
    }
    return ok({ items: [], has_more: false });
  };
  const id = seedExport('bitable');
  resumeExport(id);
  await settled('exports', id);

  const node = nodeOf(id);
  assert.equal(node.status, 'done', node.error);
  assert.equal(node.content.tables[0].records.length, 1);
  assert.equal(node.stats.skipped, 1);
  assert.match(node.warnings[0], /培训\.mp4/);
});

function docxClient(handlers = {}) {
  const calls = [];
  const handle = (method, path, body) => {
    calls.push({ method, path, body });
    for (const [pattern, fn] of Object.entries(handlers)) {
      if (`${method} ${path}`.match(pattern)) return fn(body, path);
    }
    return {};
  };
  return {
    calls,
    openId: 'me',
    get: async (path) => handle('GET', path),
    post: async (path, body) => handle('POST', path, body),
    patch: async (path, body) => handle('PATCH', path, body),
    request: async (method, path, opts) => handle(method, path, opts?.body),
    upload: async () => handlers.upload?.() ?? 'uploaded-token',
  };
}

const created = () => ({
  'GET .*/blocks/T$': () => ({ block: { children: [] } }),
  'POST .*/descendant': (body) => ({
    block_id_relations: body.descendants.map((d) => ({ temporary_block_id: d.block_id, block_id: `new-${d.block_id}` })),
  }),
  'GET .*/blocks/new-b$': () => ({ block: { board: { token: 'dstboard' } } }),
});

test('writing: a skipped file becomes text in place, also when a view wraps it', async () => {
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['t', 'i', 'view', 'bare', 'kept'] },
    { block_id: 't', block_type: 2, text: { elements: [{ text_run: { content: '正文' } }] } },
    { block_id: 'i', block_type: 27, image: { token: 'gone' } },
    { block_id: 'view', block_type: 33, view: { view_type: 1 }, children: ['f'] },
    { block_id: 'f', block_type: 23, file: { token: 'gone2', name: '培训.mp4' } },
    { block_id: 'bare', block_type: 23, file: { token: 'gone3', name: '方案.pptx' } },
    { block_id: 'kept', block_type: 27, image: { token: 'there' } },
  ];
  const client = docxClient(created());
  const warnings = new Set();
  await writeDocx({
    client,
    documentId: 'T',
    content: { blocks },
    assets: new Map([['image:there', { path: THIS_FILE, file_name: 'a.png' }]]),
    linkFor: () => null,
    warn: (w) => warnings.add(w),
  });

  const { children_id: roots, descendants } = client.calls.find((c) => c.path.endsWith('/descendant')).body;
  assert.deepEqual(roots, ['t', 'i', 'view', 'bare', 'kept']);
  const byId = new Map(descendants.map((d) => [d.block_id, d]));
  const words = (id) => byId.get(id).text.elements[0].text_run.content;
  assert.equal(words('i'), '[未迁移的内容: 图片]');
  assert.equal(words('view'), '[未迁移的内容: 附件「培训.mp4」]');
  assert.equal(words('bare'), '[未迁移的内容: 附件「方案.pptx」]');
  assert.equal(byId.has('f'), false, 'nothing is left inside the replaced view');
  assert.equal(byId.get('kept').block_type, 27);
  assert.equal(client.calls.filter((c) => c.method === 'PATCH').length, 1, 'the file that exists is still uploaded');
  assert.equal(warnings.size, 1);
});

test('writing: an upload Lark refuses costs that block, and the rest of the document continues', async () => {
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['bare', 'sheet'] },
    { block_id: 'bare', block_type: 23, file: { token: 'big', name: '培训.mp4' } },
    { block_id: 'sheet', block_type: 2, text: { elements: [{ text_run: { content: '后面的正文' } }] } },
  ];
  const client = docxClient({
    ...created(),
    upload: () => {
      throw new Error('file too large');
    },
  });
  const warnings = [];
  await writeDocx({
    client,
    documentId: 'T',
    content: { blocks },
    assets: new Map([['file:big', { path: THIS_FILE, file_name: '培训.mp4' }]]),
    linkFor: () => null,
    warn: (w) => warnings.push(w),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /培训\.mp4.*file too large/);
});

test('writing: a board keeps its layout and connectors when an image is missing', async () => {
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['b'] },
    { block_id: 'b', block_type: 43, board: { token: 'src' } },
  ];
  const nodes = [
    { id: 'i1', type: 'image', x: 10, y: 20, width: 100, height: 50, image: { token: 'gone' } },
    { id: 'c1', type: 'connector', connector: { start_object: { id: 'i1' } } },
  ];
  const client = docxClient(created());
  const warnings = [];
  await writeDocx({
    client,
    documentId: 'T',
    content: { blocks, boards: { b: nodes } },
    assets: new Map(),
    linkFor: () => null,
    warn: (w) => warnings.push(w),
  });
  const written = client.calls.find((c) => c.path === '/board/v1/whiteboards/dstboard/nodes').body.nodes;
  assert.equal(written.length, 2);
  assert.equal(written[0].id, 'i1');
  assert.equal(written[0].type, 'composite_shape');
  assert.equal(written[0].image, undefined);
  assert.equal(written[0].x, 10);
  assert.equal(warnings.length, 1);
  assert.equal(nodes[0].image.token, 'gone', 'stored source nodes stay untouched');
});

test('writing: a bitable record keeps its other values when an attachment upload is refused', async () => {
  const content = {
    tables: [
      {
        table_id: 't',
        name: '表',
        fields: [
          { field_name: '名称', type: 1, is_primary: true },
          { field_name: '附件', type: 17 },
        ],
        views: [],
        records: [
          { record_id: 'r1', fields: { 名称: 'a', 附件: [{ file_token: 'big', name: '培训.mp4' }] } },
          { record_id: 'r2', fields: { 名称: 'b', 附件: [{ file_token: 'big', name: '培训.mp4' }, { file_token: 'small', name: '小.png' }] } },
        ],
      },
    ],
  };
  let uploads = 0;
  const batches = [];
  const client = {
    get: async () => ({}),
    all: async () => [],
    post: async (path, body) => {
      if (path.endsWith('/tables')) return { table_id: 'new-t', default_view_id: 'v' };
      if (path.endsWith('/batch_create')) {
        batches.push(...body.records);
        return { records: body.records.map((_, i) => ({ record_id: `n${i}` })) };
      }
      return { field: { field_id: 'f' } };
    },
    request: async () => ({ items: [] }),
    delete: async () => ({}),
    patch: async () => ({}),
    upload: async ({ fileName }) => {
      uploads++;
      if (fileName === '培训.mp4') throw new Error('too large');
      return 'tok-small';
    },
  };
  const assets = new Map([
    ['attachment:big', { path: THIS_FILE, file_name: '培训.mp4' }],
    ['attachment:small', { path: THIS_FILE, file_name: '小.png' }],
  ]);
  const warnings = new Set();
  await writeBitable({ client, appToken: 'app', content, assets, warn: (w) => warnings.add(w) });

  assert.equal(uploads, 2, 'a refused file is not tried again for every record');
  assert.deepEqual(batches.map((r) => r.fields.附件), [[], [{ file_token: 'tok-small' }]]);
  assert.deepEqual(batches.map((r) => r.fields.名称), ['a', 'b']);
  assert.equal(warnings.size, 1);
});

test('writing: a wiki file node that cannot be uploaded becomes a stand-in and its children still arrive', async () => {
  const id = seedExport('file', 'done');
  const parent = db.prepare('SELECT id FROM nodes WHERE export_id = ?').get(id).id;
  db.prepare(`UPDATE nodes SET status = 'done', stats = '{}', warnings = '[]' WHERE id = ?`).run(parent);
  db.prepare(
    `INSERT INTO nodes (export_id, node_token, parent_token, obj_token, obj_type, node_type, title, depth, position, status, content, stats, warnings)
     VALUES (?, 'n1', 'n0', 'objc', 'docx', 'origin', '子文档', 1, 1, 'done', ?, '{}', '[]')`,
  ).run(id, JSON.stringify({ blocks: [{ block_id: 'p', block_type: 1, children: [] }] }));
  db.prepare(
    `INSERT INTO assets (export_id, node_id, kind, token, file_name, path, size) VALUES (?, ?, 'file', 'obj', '培训.mp4', ?, 1)`,
  ).run(id, parent, THIS_FILE);

  const createdNodes = [];
  const notes = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    if (path.endsWith('/get_node')) return ok({ node: { space_id: 'sp', node_token: 'target', obj_token: 'o-t', obj_type: 'docx', title: '目标', has_child: false } });
    if (path.endsWith('/root_folder/meta')) return ok({ token: 'root' });
    if (path.endsWith('/upload_all')) return Response.json({ code: 1061043, msg: 'file too large' });
    if (path.endsWith('/nodes') && init.method === 'POST') {
      const { title, parent_node_token: under, obj_type: type } = JSON.parse(init.body);
      createdNodes.push({ title, under, type });
      const token = `new-${createdNodes.length}`;
      return ok({ node: { node_token: token, obj_token: `o-${token}`, obj_type: type } });
    }
    if (path.endsWith('/children')) {
      notes.push(JSON.parse(init.body).children[0].text.elements[0].text_run.content);
      return ok({});
    }
    if (/\/blocks\/[^/]+$/.test(path)) return ok({ block: { children: [] } });
    return ok({ items: [], has_more: false });
  };

  const migration = startMigration(id, 'https://dst.larksuite.com/wiki/target');
  await settled('migrations', migration);

  assert.deepEqual(createdNodes, [
    { title: '有素材的文档', under: 'target', type: 'docx' },
    { title: '子文档', under: 'new-1', type: 'docx' },
  ]);
  const items = db
    .prepare('SELECT n.title, i.status, i.warnings FROM migration_items i JOIN nodes n ON n.id = i.node_id WHERE i.migration_id = ? ORDER BY n.position')
    .all(migration);
  assert.equal(items[0].status, 'placeholder');
  assert.match(items[0].warnings, /file too large/);
  assert.equal(items[1].status, 'done');
  assert.match(notes[0], /文件上传失败.*https:\/\/src\.test\/wiki\/n0/);
});

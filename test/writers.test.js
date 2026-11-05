import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeBitable } from '../src/bitable-writer.js';
import { writeDocx } from '../src/docx-writer.js';
import { LarkApiError } from '../src/lark.js';

function fakeClient(handlers = {}) {
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
    get: async (path) => handle('GET', path),
    post: async (path, body) => handle('POST', path, body),
    patch: async (path, body) => handle('PATCH', path, body),
    delete: async (path) => handle('DELETE', path),
    request: async (method, path, opts) => handle(method, path, opts?.body),
    all: async (path) => handle('ALL', path).items ?? [],
    upload: async () => 'uploaded-token',
  };
}

const text = (id, content, extra = {}) => ({
  block_id: id,
  block_type: 2,
  parent_id: 'doc',
  text: { elements: [{ text_run: { content, text_element_style: { bold: false, comment_ids: ['c1'], ...extra } } }], style: { align: 1 } },
});

test('docx: nested tree, stripped comments, links, mentions and unsupported blocks', async () => {
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['a', 'grid', 'chat', 'b', 'c'], page: {} },
    text('a', 'link', { link: { url: encodeURIComponent('https://src.larksuite.com/docx/SRCOBJ?x=1') } }),
    { block_id: 'grid', block_type: 24, grid: { column_size: 2 }, children: ['col'] },
    { block_id: 'col', block_type: 25, grid_column: { width_ratio: 50 }, children: ['inner'] },
    text('inner', 'nested'),
    { block_id: 'chat', block_type: 20, chat_card: { chat_id: 'x' } },
    {
      block_id: 'b',
      block_type: 2,
      text: { elements: [
        { mention_user: { user_id: 'ou_src', text_element_style: {} } },
        { mention_doc: { token: 'SRCOBJ', obj_type: 22, url: encodeURIComponent('https://src.larksuite.com/docx/SRCOBJ'), title: 'Doc', text_element_style: {} } },
      ] },
    },
    { block_id: 'c', block_type: 27, image: { token: 'imgtok', width: 100, height: 50 } },
  ];
  const client = fakeClient({
    'GET .*/blocks/T$': () => ({ block: { children: ['seed'] } }),
    'POST .*/descendant': (body) => ({
      block_id_relations: body.descendants.map((d) => ({ temporary_block_id: d.block_id, block_id: `new-${d.block_id}` })),
    }),
  });
  const warnings = [];
  await writeDocx({
    client,
    documentId: 'T',
    content: { blocks },
    assets: new Map([['image:imgtok', { path: new URL(import.meta.url).pathname, file_name: 'a.png' }]]),
    linkFor: (url) => (url.includes('SRCOBJ') ? 'https://dst.larksuite.com/wiki/DSTNODE' : null),
    warn: (m) => warnings.push(m),
  });

  assert.ok(client.calls.find((c) => c.method === 'DELETE' && c.path.endsWith('batch_delete')), 'clears the seed block');
  const create = client.calls.find((c) => c.path.endsWith('/descendant'));
  assert.deepEqual(create.body.children_id, ['a', 'grid', 'chat', 'b', 'c']);
  const byId = Object.fromEntries(create.body.descendants.map((d) => [d.block_id, d]));
  assert.deepEqual(byId.grid.children, ['col']);
  assert.deepEqual(byId.col.children, ['inner']);
  assert.equal(byId.chat.block_type, 2);

  const style = byId.a.text.elements[0].text_run.text_element_style;
  assert.equal(style.comment_ids, undefined);
  assert.equal(decodeURIComponent(style.link.url), 'https://dst.larksuite.com/wiki/DSTNODE');

  const [user, doc] = byId.b.text.elements;
  assert.equal(user.text_run.content, '@用户');
  assert.equal(decodeURIComponent(doc.text_run.text_element_style.link.url), 'https://dst.larksuite.com/wiki/DSTNODE');

  const replace = client.calls.find((c) => c.method === 'PATCH' && c.path.endsWith('new-c'));
  assert.deepEqual(replace.body.replace_image, { token: 'uploaded-token', width: 100, height: 50 });
  assert.equal(warnings.length, 2);
});

test('docx: table keeps structure and merges cells by row/column', async () => {
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['t'], page: {} },
    {
      block_id: 't',
      block_type: 31,
      children: ['c1', 'c2', 'c3', 'c4'],
      table: { cells: ['c1', 'c2', 'c3', 'c4'], property: {
        row_size: 2, column_size: 2, column_width: [100, 100],
        merge_info: [{ row_span: 1, col_span: 2 }, { row_span: 1, col_span: 1 }, { row_span: 1, col_span: 1 }, { row_span: 1, col_span: 1 }],
      } },
    },
    ...['c1', 'c2', 'c3', 'c4'].map((id) => ({ block_id: id, block_type: 32, table_cell: {}, children: [] })),
  ];
  const client = fakeClient({
    'GET .*/blocks/T$': () => ({ block: { children: [] } }),
    'POST .*/descendant': (body) => ({
      block_id_relations: body.descendants.map((d) => ({ temporary_block_id: d.block_id, block_id: `new-${d.block_id}` })),
    }),
  });
  await writeDocx({ client, documentId: 'T', content: { blocks }, assets: new Map(), linkFor: () => null, warn: () => {} });
  const create = client.calls.find((c) => c.path.endsWith('/descendant'));
  const table = create.body.descendants.find((d) => d.block_id === 't');
  assert.equal(table.table.property.merge_info, undefined);
  assert.equal(table.table.cells, undefined);
  const merge = client.calls.find((c) => c.method === 'PATCH' && c.body.merge_table_cells);
  assert.deepEqual(merge.body.merge_table_cells, { row_start_index: 0, row_end_index: 1, column_start_index: 0, column_end_index: 2 });
});

test('bitable: maps fields, values and link records, removes the default table', async () => {
  let next = 0;
  const client = fakeClient({
    'ALL .*/tables$': () => ({ items: [{ table_id: 'default' }] }),
    'POST .*/apps/APP/tables$': () => ({ table_id: `new${++next}` }),
    'POST .*/records/batch_create': (body) => ({ records: body.records.map((_, i) => ({ record_id: `r${++next}-${i}` })) }),
  });
  const warnings = [];
  const content = {
    tables: [
      {
        table_id: 'A',
        name: 'Tasks',
        views: [{ view_name: 'Grid', view_type: 'grid' }, { view_name: 'Board', view_type: 'kanban' }],
        fields: [
          { field_name: 'Name', type: 1, is_primary: true },
          { field_name: 'Owner', type: 11 },
          { field_name: 'Status', type: 3, property: { options: [{ id: 'opt1', name: 'Open', color: 1 }] } },
          { field_name: 'Ref', type: 18, property: { table_id: 'B', multiple: true } },
          { field_name: 'Created', type: 1001, property: { date_formatter: 'yyyy/MM/dd' } },
        ],
        records: [{
          record_id: 'a1',
          fields: {
            Name: [{ text: 'Task ', type: 'text' }, { text: 'one', type: 'text' }],
            Owner: [{ name: 'Liquid', id: 'ou_src' }],
            Status: 'Open',
            Ref: { link_record_ids: ['b1'] },
            Created: 1700000000000,
          },
        }],
      },
      { table_id: 'B', name: 'Refs', views: [], fields: [{ field_name: 'Name', type: 1, is_primary: true }], records: [{ record_id: 'b1', fields: { Name: 'x' } }] },
    ],
  };
  await writeBitable({ client, appToken: 'APP', content, assets: new Map(), warn: (m) => warnings.push(m) });

  const tableCall = client.calls.find((c) => c.method === 'POST' && c.path.endsWith('/APP/tables'));
  const names = tableCall.body.table.fields.map((f) => f.field_name);
  assert.deepEqual(names, ['Name', 'Owner', 'Status', 'Created']);
  const fields = Object.fromEntries(tableCall.body.table.fields.map((f) => [f.field_name, f]));
  assert.equal(fields.Owner.type, 1);
  assert.equal(fields.Created.type, 5);
  assert.deepEqual(fields.Status.property.options, [{ name: 'Open', color: 1 }]);

  const row = client.calls.find((c) => c.path.endsWith('batch_create')).body.records[0].fields;
  assert.equal(row.Name, 'Task one');
  assert.equal(row.Owner, 'Liquid');
  assert.equal(row.Ref, undefined);

  const link = client.calls.find((c) => c.path.endsWith('/fields') && c.body.type === 18);
  assert.equal(link.body.property.table_id, 'new3');
  assert.ok(link.path.includes('new1'));

  const update = client.calls.find((c) => c.path.endsWith('batch_update'));
  assert.equal(update.body.records.length, 1);
  assert.equal(update.body.records[0].fields.Ref.length, 1);

  assert.ok(client.calls.find((c) => c.method === 'DELETE' && c.path.endsWith('/tables/default')));
});

test('docx: board is rebuilt from nodes with re-uploaded images, never as an image block', async () => {
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['b'], page: {} },
    { block_id: 'b', block_type: 43, board: { token: 'srcboard' } },
  ];
  const nodes = [
    { id: 'o1:1', type: 'composite_shape', composite_shape: { type: 'round_rect' } },
    { id: 'c1:1', type: 'connector', connector: { start_object: { id: 'o1:1' } } },
    { id: 'd1:1', type: 'image', image: { token: 'srcimg' } },
  ];
  const client = fakeClient({
    'GET .*/blocks/T$': () => ({ block: { children: [] } }),
    'POST .*/descendant': (body) => ({
      block_id_relations: body.descendants.map((d) => ({ temporary_block_id: d.block_id, block_id: `new-${d.block_id}` })),
    }),
    'GET .*/blocks/new-b$': () => ({ block: { board: { token: 'dstboard' } } }),
  });
  await writeDocx({
    client,
    documentId: 'T',
    content: { blocks, boards: { b: nodes } },
    assets: new Map([['board-image:srcimg', { path: new URL(import.meta.url).pathname, file_name: 'a.png' }]]),
    linkFor: () => null,
    warn: () => {},
  });
  const created = client.calls.find((c) => c.path.endsWith('/descendant')).body.descendants[0];
  assert.equal(created.block_type, 43);
  const written = client.calls.find((c) => c.path === '/board/v1/whiteboards/dstboard/nodes').body.nodes;
  assert.equal(written.length, 3);
  assert.equal(written[2].image.token, 'uploaded-token');
  assert.equal(nodes[2].image.token, 'srcimg', 'stored source nodes stay untouched');
});

test('docx: resource blocks are split across create calls and keep document order', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `b${i}`);
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ids, page: {} },
    ...ids.map((id) => ({ block_id: id, block_type: 43, board: { token: id } })),
  ];
  const client = fakeClient({
    'GET .*/blocks/T$': () => ({ block: { children: [] } }),
    'POST .*/descendant': (body) => ({ block_id_relations: [] }),
  });
  await writeDocx({ client, documentId: 'T', content: { blocks }, assets: new Map(), linkFor: () => null, warn: () => {} });
  const calls = client.calls.filter((c) => c.path.endsWith('/descendant'));
  assert.deepEqual(calls.map((c) => c.body.children_id.length), [5, 5, 2]);
  assert.deepEqual(calls.map((c) => c.body.index), [0, 5, 10]);
  assert.deepEqual(calls.flatMap((c) => c.body.children_id), ids);
});

function rejectingClient(isRejected) {
  const client = fakeClient({ 'GET .*/blocks/T$': () => ({ block: { children: [] } }) });
  const accepted = [];
  const realPost = client.post;
  client.accepted = accepted;
  client.post = async (path, body, query) => {
    if (path.endsWith('/descendant')) {
      if (body.descendants.some(isRejected)) {
        throw new LarkApiError('rejected', { code: 1770001 });
      }
      accepted.push({ index: body.index, roots: body.children_id, blocks: body.descendants });
      return { block_id_relations: [] };
    }
    return realPost(path, body, query);
  };
  return client;
}

test('docx: a line holding only a dropped inline element is sent with an empty run, not an empty list', async () => {
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['a', 'b'], page: {} },
    { block_id: 'a', block_type: 2, text: { elements: [{ inline_block: { block_id: 'x' } }] } },
    { block_id: 'b', block_type: 17, todo: { elements: [] } },
  ];
  const client = fakeClient({ 'GET .*/blocks/T$': () => ({ block: { children: [] } }), 'POST .*/descendant': () => ({}) });
  const warnings = [];
  await writeDocx({ client, documentId: 'T', content: { blocks }, assets: new Map(), linkFor: () => null, warn: (m) => warnings.push(m) });
  const sent = client.calls.find((c) => c.path.endsWith('/descendant')).body.descendants;
  for (const [i, key] of [[0, 'text'], [1, 'todo']]) {
    assert.deepEqual(sent[i][key].elements, [{ text_run: { content: '' } }]);
  }
  assert.equal(warnings.length, 1);
});

test('docx: containers without children get an empty line, which Lark requires', async () => {
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['c', 'q'], page: {} },
    { block_id: 'c', block_type: 19, callout: { emoji_id: 'gift' } },
    { block_id: 'q', block_type: 34, quote_container: {} },
  ];
  const client = fakeClient({ 'GET .*/blocks/T$': () => ({ block: { children: [] } }), 'POST .*/descendant': () => ({}) });
  await writeDocx({ client, documentId: 'T', content: { blocks }, assets: new Map(), linkFor: () => null, warn: () => {} });
  const sent = client.calls.find((c) => c.path.endsWith('/descendant')).body;
  const byId = Object.fromEntries(sent.descendants.map((d) => [d.block_id, d]));
  assert.deepEqual(byId.c.children, ['c-empty']);
  assert.deepEqual(byId.q.children, ['q-empty']);
  assert.equal(byId['c-empty'].block_type, 2);
  assert.deepEqual(sent.children_id, ['c', 'q']);
});

test('docx: links Lark would refuse lose the link and keep the text', async () => {
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['a', 'b', 'c'], page: {} },
    text('a', 'relative', { link: { url: encodeURIComponent('/wiki/abc') } }),
    text('b', 'good', { link: { url: encodeURIComponent('https://example.com/x') } }),
    { block_id: 'c', block_type: 2, text: { elements: [{ mention_doc: { title: '无权限文档', url: '' } }] } },
  ];
  const client = fakeClient({ 'GET .*/blocks/T$': () => ({ block: { children: [] } }), 'POST .*/descendant': () => ({}) });
  await writeDocx({ client, documentId: 'T', content: { blocks }, assets: new Map(), linkFor: () => null, warn: () => {} });
  const byId = Object.fromEntries(client.calls.find((c) => c.path.endsWith('/descendant')).body.descendants.map((d) => [d.block_id, d]));
  const run = (id) => byId[id].text.elements[0].text_run;
  assert.equal(run('a').text_element_style.link, undefined);
  assert.equal(run('a').content, 'relative');
  assert.equal(decodeURIComponent(run('b').text_element_style.link.url), 'https://example.com/x');
  assert.equal(run('c').content, '无权限文档');
  assert.equal(run('c').text_element_style?.link, undefined);
});

test('docx: one rejected block becomes plain text; the rest keep their format and order', async () => {
  const ids = ['b1', 'b2', 'bad', 'b4', 'b5'];
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ids, page: {} },
    ...ids.map((id) => ({ block_id: id, block_type: 3, heading1: { elements: [{ text_run: { content: id } }] } })),
  ];
  const client = rejectingClient((block) => block.block_id === 'bad');
  const warnings = [];
  await writeDocx({ client, documentId: 'T', content: { blocks }, assets: new Map(), linkFor: () => null, warn: (m) => warnings.push(m) });

  const roots = client.accepted.flatMap((call) => call.roots);
  assert.deepEqual(roots, ['b1', 'b2', 'bad-plain-0', 'b4', 'b5']);
  let expected = 0;
  for (const call of client.accepted) {
    assert.equal(call.index, expected, 'each call inserts right after the previous one');
    expected += call.roots.length;
  }
  const blocksById = Object.fromEntries(client.accepted.flatMap((c) => c.blocks).map((b) => [b.block_id, b]));
  assert.equal(blocksById.b1.block_type, 3, 'neighbours keep their format');
  assert.equal(blocksById['bad-plain-0'].block_type, 2);
  assert.equal(blocksById['bad-plain-0'].text.elements[0].text_run.content, 'bad');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /1770001/);
});

test('docx: errors that are not about the content still fail the document', async () => {
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['a'], page: {} },
    text('a', 'x'),
  ];
  const client = fakeClient({ 'GET .*/blocks/T$': () => ({ block: { children: [] } }) });
  client.post = async () => {
    throw new LarkApiError('forbidden', { code: 1770032 });
  };
  await assert.rejects(
    writeDocx({ client, documentId: 'T', content: { blocks }, assets: new Map(), linkFor: () => null, warn: () => {} }),
    /forbidden/,
  );
});

test('docx: an embedded bitable is created as a real block and its table filled in place', async () => {
  const table = {
    table_id: 'srcTbl',
    views: [{ view_name: '总览', view_type: 'grid' }],
    fields: [
      { field_name: '事项', type: 1, is_primary: true },
      { field_name: '状态', type: 3, property: { options: [{ id: 'o', name: '开始', color: 1 }] } },
      { field_name: '自关联', type: 18, property: { table_id: 'srcTbl', multiple: true } },
    ],
    records: [
      { record_id: 'r1', fields: { 事项: '甲', 状态: '开始' } },
      { record_id: 'r2', fields: { 事项: '乙', 自关联: { link_record_ids: ['r1'] } } },
    ],
  };
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['e'], page: {} },
    { block_id: 'e', block_type: 18, bitable: { token: 'srcApp_srcTbl', view_type: 1 } },
  ];
  let created = 0;
  const client = fakeClient({
    'GET .*/blocks/T$': () => ({ block: { children: [] } }),
    'POST .*/descendant': (body) => ({
      block_id_relations: body.descendants.map((d) => ({ temporary_block_id: d.block_id, block_id: `new-${d.block_id}` })),
    }),
    'GET .*/blocks/new-e$': () => ({ block: { bitable: { token: 'newApp_newTbl' } } }),
    'ALL .*/fields$': () => ({ items: [{ field_id: 'p', field_name: '文本', is_primary: true }, { field_id: 'x', field_name: '状态' }] }),
    'ALL .*/records$': () => ({ items: [{ record_id: 'blank1' }, { record_id: 'blank2' }] }),
    'ALL .*/views$': () => ({ items: [{ view_id: 'v1', view_name: '表格' }] }),
    'POST .*/records/batch_create': (body) => ({ records: body.records.map(() => ({ record_id: `n${++created}` })) }),
  });
  const warnings = [];
  await writeDocx({
    client,
    documentId: 'T',
    content: { blocks, embeddedBitables: { e: table } },
    assets: new Map(),
    linkFor: () => null,
    warn: (m) => warnings.push(m),
  });

  const sent = client.calls.find((c) => c.path.endsWith('/descendant')).body.descendants[0];
  assert.equal(sent.block_type, 18, 'not replaced by a placeholder');
  assert.deepEqual(sent.bitable, { view_type: 1 });

  const base = '/bitable/v1/apps/newApp/tables/newTbl';
  const order = client.calls.filter((c) => c.path.startsWith(base) && c.method !== 'ALL').map((c) => `${c.method} ${c.path.slice(base.length)}`);
  assert.equal(order[0], 'PUT /fields/p', 'the primary field is converted first');
  assert.ok(order.indexOf('DELETE /fields/x') < order.indexOf('POST /fields'), 'a default field is removed before a same-named one is added');
  assert.ok(order.includes('POST /records/batch_delete'), 'blank rows are removed');
  assert.ok(!order.some((call) => call.startsWith('DELETE /tables')), 'the table the block points at survives');

  const primary = client.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/fields/p'));
  assert.equal(primary.body.field_name, '事项');
  const link = client.calls.find((c) => c.method === 'POST' && c.path === `${base}/fields` && c.body.type === 18);
  assert.equal(link.body.property.table_id, 'newTbl', 'a self link points at the new table');
  const update = client.calls.find((c) => c.path.endsWith('batch_update'));
  assert.deepEqual(update.body.records, [{ record_id: 'n2', fields: { 自关联: ['n1'] } }]);
});

test('docx: an embedded bitable that could not be read falls back to a placeholder', async () => {
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['e'], page: {} },
    { block_id: 'e', block_type: 18, bitable: { token: 'a_b', view_type: 1 } },
  ];
  const client = fakeClient({ 'GET .*/blocks/T$': () => ({ block: { children: [] } }), 'POST .*/descendant': () => ({}) });
  await writeDocx({ client, documentId: 'T', content: { blocks }, assets: new Map(), linkFor: () => null, warn: () => {} });
  const sent = client.calls.find((c) => c.path.endsWith('/descendant')).body.descendants[0];
  assert.equal(sent.block_type, 2);
});

test('docx: a rejected table falls back to one line per row', async () => {
  const cellIds = ['c0', 'c1', 'c2', 'c3'];
  const blocks = [
    { block_id: 'doc', block_type: 1, children: ['t'], page: {} },
    { block_id: 't', block_type: 31, children: cellIds, table: { property: { row_size: 2, column_size: 2 } } },
    ...cellIds.flatMap((id) => [
      { block_id: id, block_type: 32, table_cell: {}, children: [`${id}t`] },
      { block_id: `${id}t`, block_type: 2, text: { elements: [{ text_run: { content: id } }] } },
    ]),
  ];
  const client = rejectingClient((block) => block.block_type === 31);
  await writeDocx({ client, documentId: 'T', content: { blocks }, assets: new Map(), linkFor: () => null, warn: () => {} });
  const lines = client.accepted.flatMap((c) => c.blocks).map((b) => b.text.elements[0].text_run.content);
  assert.deepEqual(lines, ['c0 | c1', 'c2 | c3']);
});

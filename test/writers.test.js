import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeBitable } from '../src/bitable-writer.js';
import { writeDocx } from '../src/docx-writer.js';

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

// Reads a wiki subtree into the local database and blob directory.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clientForJob } from './auth.js';
import { BLOB_DIR, db } from './db.js';
import { appConfig, columnName, concurrencyFromEnv, documentHost, mapConcurrent, parseWikiUrl, pollDelay } from './lark.js';

const readConcurrency = () => concurrencyFromEnv('READ_CONCURRENCY', 8, 32);

const BLOCK_IMAGE = 27;
const BLOCK_FILE = 23;
const BLOCK_BITABLE = 18;
const BLOCK_SHEET = 30;
const BLOCK_BOARD = 43;
const BITABLE_ATTACHMENT = 17;
// One past the writer's 100x100 limit, so the writer can tell when it truncated.
const MAX_EMBED_ROWS = 101;
const MAX_EMBED_COLUMNS = 101;
const MY_LIBRARY = 'my_library';

export function startExport(sourceUrl) {
  const { host, token, apiBase } = parseWikiUrl(sourceUrl);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO exports (source_url, host, api_base, root_token, phase, created_at)
       VALUES (?, ?, ?, ?, 'tree', ?)`,
    )
    .run(sourceUrl.trim(), host, apiBase, token, Date.now());
  const id = Number(lastInsertRowid);
  runExport(id).catch((err) => failExport(id, err));
  return id;
}

// Reads everything in the member's own library. There is no link: the library is theirs by login.
export function startLibraryExport(ownerId) {
  const running = db
    .prepare(`SELECT id FROM exports WHERE owner_id = ? AND status IN ('running', 'pausing') LIMIT 1`)
    .get(ownerId);
  if (running) throw new Error('你的文档库正在读取中');
  const { apiBase, host } = appConfig('source');
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO exports (source_url, host, api_base, root_token, root_title, phase, created_at, owner_id)
       VALUES ('', ?, ?, ?, '我的文档库', 'tree', ?, ?)`,
    )
    .run(host, apiBase, MY_LIBRARY, Date.now(), ownerId);
  const id = Number(lastInsertRowid);
  runExport(id).catch((err) => failExport(id, err));
  return id;
}

// Removes a read and its copies of the documents from this server. Lark itself is not touched.
export function deleteExport(id) {
  const job = getExport(id);
  const busy = db
    .prepare(`SELECT COUNT(*) AS n FROM migrations WHERE export_id = ? AND status IN ('running', 'pausing')`)
    .get(id).n;
  const reading = db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE export_id = ? AND status = 'reading'`).get(id).n;
  if (isActive(job.status) || busy || reading) throw new Error('还有任务在进行中，请等它停下后再删除');
  db.prepare('DELETE FROM exports WHERE id = ?').run(id);
  rmSync(join(BLOB_DIR, String(id)), { recursive: true, force: true });
}

const isActive = (status) => status === 'running' || status === 'pausing';

function getExport(id) {
  const job = db.prepare('SELECT * FROM exports WHERE id = ?').get(id);
  if (!job) throw new Error('找不到这次读取记录');
  return job;
}

// Continues the remaining nodes, reusing the stored tree when one exists.
export function resumeExport(id, { retryFailed = false } = {}) {
  if (isActive(getExport(id).status)) throw new Error('读取还在进行中，请等它停下后再继续');
  if (retryFailed) {
    db.prepare(`UPDATE nodes SET status = 'pending', error = NULL WHERE export_id = ? AND status = 'failed'`).run(id);
  }
  db.prepare(`UPDATE exports SET status = 'running', error = NULL, finished_at = NULL WHERE id = ?`).run(id);
  runExport(id).catch((err) => failExport(id, err));
}

// Stops starting new nodes. Whatever is in flight finishes, then the run settles as paused.
export function pauseExport(id) {
  getExport(id);
  const { changes } = db.prepare(`UPDATE exports SET status = 'pausing' WHERE id = ? AND status = 'running'`).run(id);
  if (!changes) throw new Error('读取没有在进行中');
}

// Re-reads one failed node on its own. It can run alongside a job: a job only picks up
// pending nodes, and this one moves straight from failed to reading.
export function retryNode(exportId, nodeId) {
  const job = getExport(exportId);
  const node = db.prepare('SELECT * FROM nodes WHERE id = ? AND export_id = ?').get(nodeId, exportId);
  if (!node) throw new Error('找不到这个文档');
  if (node.status !== 'failed') throw new Error('只有读取失败的文档可以重试');
  markReading(node);
  readNodeSafely(clientForJob('source', job), job, node).finally(() => settleExport(exportId));
}

function markReading(node) {
  db.prepare(`UPDATE nodes SET status = 'reading', error = NULL WHERE id = ?`).run(node.id);
}

async function readNodeSafely(client, job, node) {
  markReading(node);
  try {
    await readNode(client, job, node);
  } catch (err) {
    db.prepare(`UPDATE nodes SET status = 'failed', error = ? WHERE id = ?`).run(err.message, node.id);
  }
}

// Works out a job's final status from its nodes. A single retry settles too, but must not
// overrule a run still in progress; that run settles itself when it ends.
function settleExport(id, { endOfRun = false } = {}) {
  const job = getExport(id);
  if (!endOfRun && (isActive(job.status) || !job.tree_complete)) return;
  const count = (status) =>
    db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE export_id = ? AND status = ?').get(id, status).n;
  let status = count('failed') ? 'partial' : 'done';
  if (count('pending')) status = endOfRun ? 'paused' : job.status;
  db.prepare(`UPDATE exports SET status = ?, phase = NULL, finished_at = ? WHERE id = ?`).run(status, Date.now(), id);
}

function failExport(id, err) {
  db.prepare(`UPDATE exports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
    err.message,
    Date.now(),
    id,
  );
}

async function runExport(id) {
  const job = db.prepare('SELECT * FROM exports WHERE id = ?').get(id);
  const client = clientForJob('source', job);

  // A walk that died midway leaves a partial tree, which must not pass for the whole subtree.
  if (!job.tree_complete) {
    db.prepare('DELETE FROM nodes WHERE export_id = ?').run(id);
    db.prepare(`UPDATE exports SET phase = 'tree' WHERE id = ?`).run(id);
    await readTree(client, job);
    db.prepare('UPDATE exports SET tree_complete = 1 WHERE id = ?').run(id);
  }

  db.prepare(`UPDATE exports SET phase = 'content' WHERE id = ?`).run(id);
  const pending = db
    .prepare(`SELECT * FROM nodes WHERE export_id = ? AND status = 'pending' ORDER BY position`)
    .all(id);
  await mapConcurrent(pending, readConcurrency(), (node) => readNodeSafely(client, job, node), {
    shouldStop: () => getExport(id).status === 'pausing',
  });
  settleExport(id, { endOfRun: true });
}

async function readTree(client, job) {
  const roots = job.owner_id === null ? [await linkedRoot(client, job)] : await libraryRoots(client, job);

  const insert = db.prepare(
    `INSERT INTO nodes (export_id, node_token, parent_token, obj_token, obj_type, node_type,
                        origin_node_token, title, depth, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let discovered = 0;
  const record = (node, parentToken, depth) =>
    insert.run(
      job.id,
      node.node_token,
      parentToken,
      node.obj_token,
      node.obj_type,
      node.node_type,
      node.origin_node_token ?? null,
      node.title,
      depth,
      discovered++,
    );

  // Walked level by level so siblings can be listed in parallel. Rows go in as they are
  // found to keep the live count moving, and get their final order once the walk is done.
  for (const root of roots) record(root, null, 0);
  const childrenOf = new Map();
  let level = roots;
  for (let depth = 1; level.length; depth++) {
    const parents = level.filter((node) => node.has_child);
    const next = [];
    await mapConcurrent(parents, readConcurrency(), async (parent) => {
      const children = await client.all(`/wiki/v2/spaces/${parent.space_id}/nodes`, {
        parent_node_token: parent.node_token,
        page_size: 50,
      });
      childrenOf.set(parent.node_token, children);
      for (const child of children) {
        record(child, parent.node_token, depth);
        next.push(child);
      }
    });
    level = next;
  }

  const setPosition = db.prepare('UPDATE nodes SET position = ? WHERE export_id = ? AND node_token = ?');
  let position = 0;
  const number = (node) => {
    setPosition.run(position++, job.id, node.node_token);
    for (const child of childrenOf.get(node.node_token) ?? []) number(child);
  };
  db.exec('BEGIN');
  try {
    roots.forEach(number);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function linkedRoot(client, job) {
  const { node: root } = await client.get('/wiki/v2/spaces/get_node', { token: job.root_token });
  db.prepare('UPDATE exports SET root_title = ? WHERE id = ?').run(root.title, job.id);
  return root;
}

async function libraryRoots(client, job) {
  const { space } = await client.get(`/wiki/v2/spaces/${MY_LIBRARY}`);
  const roots = await client.all(`/wiki/v2/spaces/${space.space_id}/nodes`, { page_size: 50 });
  if (roots.length) {
    db.prepare('UPDATE exports SET host = ? WHERE id = ?').run(await documentHost(client, roots[0], job.host), job.id);
  }
  return roots;
}

async function readNode(client, job, node) {
  const saved = (kind, token, buffer, fileName) => saveAsset(job.id, node, kind, token, buffer, fileName);
  let result;
  if (node.node_type === 'shortcut') {
    result = { stats: {}, warnings: [] };
  } else if (node.obj_type === 'docx') {
    result = await readDocx(client, node, saved);
  } else if (node.obj_type === 'sheet') {
    result = await readSheet(client, node, saved);
  } else if (node.obj_type === 'bitable') {
    result = await readBitable(client, node, saved);
  } else if (node.obj_type === 'file') {
    result = await readFile(client, node, saved);
  } else {
    db.prepare(`UPDATE nodes SET status = 'unsupported', warnings = ? WHERE id = ?`).run(
      JSON.stringify([`Lark 暂未提供 ${node.obj_type} 类型的读取接口，迁移时会生成占位文档`]),
      node.id,
    );
    return;
  }
  db.prepare(`UPDATE nodes SET status = 'done', content = ?, stats = ?, warnings = ? WHERE id = ?`).run(
    result.content ? JSON.stringify(result.content) : null,
    JSON.stringify(result.stats),
    JSON.stringify(result.warnings),
    node.id,
  );
}

function saveAsset(exportId, node, kind, token, buffer, fileName) {
  // Stored relative to the blob directory, so the data folder can move (for example into a container).
  const path = join(String(exportId), String(node.id), `${kind}-${token}`);
  mkdirSync(dirname(join(BLOB_DIR, path)), { recursive: true });
  writeFileSync(join(BLOB_DIR, path), buffer);
  db.prepare(
    `INSERT OR REPLACE INTO assets (export_id, node_id, kind, token, file_name, path, size)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(exportId, node.id, kind, token, fileName ?? null, path, buffer.length);
}

async function readDocx(client, node, saved) {
  const blocks = await client.all(`/docx/v1/documents/${node.obj_token}/blocks`, {
    page_size: 500,
    document_revision_id: -1,
  });
  const warnings = [];
  const stats = { blocks: blocks.length, images: 0, files: 0, boards: 0, embeds: 0 };
  const embeddedSheets = {};
  const boards = {};
  const embeddedBitables = {};
  const embedStats = { fields: 0, records: 0, attachments: 0 };

  for (const block of blocks) {
    if (block.block_type === BLOCK_IMAGE && block.image?.token) {
      const file = await client.download(`/drive/v1/medias/${block.image.token}/download`);
      saved('image', block.image.token, file.buffer, file.fileName);
      stats.images++;
    } else if (block.block_type === BLOCK_FILE && block.file?.token) {
      const file = await client.download(`/drive/v1/medias/${block.file.token}/download`);
      saved('file', block.file.token, file.buffer, file.fileName ?? block.file.name);
      stats.files++;
    } else if (block.block_type === BLOCK_BOARD && block.board?.token) {
      const { nodes = [] } = await client.get(`/board/v1/whiteboards/${block.board.token}/nodes`);
      for (const boardNode of nodes) {
        if (!boardNode.image?.token) continue;
        const file = await client.download(`/drive/v1/medias/${boardNode.image.token}/download`);
        saved('board-image', boardNode.image.token, file.buffer, file.fileName);
      }
      boards[block.block_id] = nodes;
      stats.boards++;
    } else if (block.block_type === BLOCK_BITABLE && block.bitable?.token) {
      // One unreadable embed should cost that block, not the whole document.
      try {
        const separator = block.bitable.token.lastIndexOf('_');
        embeddedBitables[block.block_id] = await readBitableTable(
          client,
          block.bitable.token.slice(0, separator),
          { table_id: block.bitable.token.slice(separator + 1) },
          saved,
          embedStats,
        );
        stats.embeds++;
      } catch (err) {
        warnings.push(`有内嵌多维表格读取失败，迁移后为文字占位: ${err.message}`);
      }
    } else if (block.block_type === BLOCK_SHEET && block.sheet?.token) {
      // One unreadable embed should cost that block, not the whole document.
      try {
        embeddedSheets[block.block_id] = await readEmbeddedSheet(client, block.sheet.token);
        stats.embeds++;
        warnings.push('内嵌电子表格只迁移单元格的值，样式不保留');
      } catch (err) {
        warnings.push(`有内嵌电子表格读取失败，迁移后为空表: ${err.message}`);
      }
    }
  }
  return {
    content: { blocks, embeddedSheets, boards, embeddedBitables },
    stats: { ...stats, ...embedStats },
    warnings: [...new Set(warnings)],
  };
}

async function readEmbeddedSheet(client, token) {
  const separator = token.lastIndexOf('_');
  const spreadsheet = token.slice(0, separator);
  const sheetId = token.slice(separator + 1);
  const { sheet } = await client.get(`/sheets/v3/spreadsheets/${spreadsheet}/sheets/${sheetId}`);
  const rows = Math.min(sheet.grid_properties.row_count, MAX_EMBED_ROWS);
  const columns = Math.min(sheet.grid_properties.column_count, MAX_EMBED_COLUMNS);
  const data = await client.get(
    `/sheets/v2/spreadsheets/${spreadsheet}/values/${sheetId}!A1:${columnName(columns)}${rows}`,
    { valueRenderOption: 'FormattedValue' },
  );
  return trimGrid(data.valueRange?.values ?? []);
}

// Sheets report their full grid, so drop the empty margin before sizing the new block.
function trimGrid(values) {
  const isEmpty = (cell) => cell === null || cell === undefined || cell === '';
  const rows = values.map((row) => {
    let end = row.length;
    while (end > 0 && isEmpty(row[end - 1])) end--;
    return row.slice(0, end);
  });
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

async function readSheet(client, node, saved) {
  const { sheets = [] } = await client.get(`/sheets/v3/spreadsheets/${node.obj_token}/sheets/query`);
  const buffer = await exportToBuffer(client, node.obj_token, 'sheet', 'xlsx');
  saved('xlsx', node.obj_token, buffer, `${node.title || 'sheet'}.xlsx`);
  return {
    stats: { sheets: sheets.length, size: buffer.length },
    warnings: ['电子表格经 xlsx 导入，单元格中的 @人员 会变为文本'],
  };
}

async function exportToBuffer(client, token, type, extension) {
  const { ticket } = await client.post('/drive/v1/export_tasks', { file_extension: extension, token, type });
  for (let attempt = 0; attempt < 120; attempt++) {
    const { result } = await client.get(`/drive/v1/export_tasks/${ticket}`, { token });
    if (result.job_status === 0) {
      const file = await client.download(`/drive/v1/export_tasks/file/${result.file_token}/download`);
      return file.buffer;
    }
    if (result.job_status !== 1 && result.job_status !== 2) {
      throw new Error(`导出失败: ${result.job_error_msg || result.job_status}`);
    }
    await pollDelay(attempt);
  }
  throw new Error('导出超时');
}

async function readBitable(client, node, saved) {
  const app = node.obj_token;
  const tables = await client.all(`/bitable/v1/apps/${app}/tables`, { page_size: 100 });
  const stats = { tables: tables.length, fields: 0, records: 0, attachments: 0 };
  const content = { tables: [] };

  for (const table of tables) {
    content.tables.push(await readBitableTable(client, app, table, saved, stats));
  }
  return { content, stats, warnings: [] };
}

async function readBitableTable(client, app, table, saved, stats) {
  const base = `/bitable/v1/apps/${app}/tables/${table.table_id}`;
  const fields = await client.all(`${base}/fields`, { page_size: 100 });
  const views = await client.all(`${base}/views`, { page_size: 100 });
  const records = await client.all(`${base}/records`, { page_size: 500 });
  stats.fields += fields.length;
  stats.records += records.length;

  const attachmentFields = fields.filter((f) => f.type === BITABLE_ATTACHMENT).map((f) => f.field_name);
  const seen = new Set();
  for (const record of records) {
    for (const name of attachmentFields) {
      for (const item of record.fields[name] || []) {
        if (seen.has(item.file_token)) continue;
        seen.add(item.file_token);
        const file = await client.download(`/drive/v1/medias/${item.file_token}/download`);
        saved('attachment', item.file_token, file.buffer, item.name);
        stats.attachments++;
      }
    }
  }
  return {
    table_id: table.table_id,
    name: table.name,
    fields,
    views,
    records: records.map(({ record_id, fields: values }) => ({ record_id, fields: values })),
  };
}

async function readFile(client, node, saved) {
  const file = await client.download(`/drive/v1/files/${node.obj_token}/download`);
  saved('file', node.obj_token, file.buffer, file.fileName ?? node.title);
  return { stats: { size: file.buffer.length }, warnings: [] };
}

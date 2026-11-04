// Writes a stored export under a target wiki node: structure first, then content.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BLOB_DIR, db, parseJson } from './db.js';
import { clientFor, parseWikiUrl, pollDelay } from './lark.js';
import { writeBitable } from './bitable-writer.js';
import { writeDocx } from './docx-writer.js';

const URL_TOKEN = /\/(?:wiki|docx|docs|sheets|base|bitable|file|mindnote|slides)\/([A-Za-z0-9]+)/;

export function startMigration(exportId, targetUrl) {
  const job = db.prepare('SELECT * FROM exports WHERE id = ?').get(exportId);
  if (!job) throw new Error('找不到这次读取记录');
  if (job.status === 'running') throw new Error('读取尚未完成');
  if (!job.tree_complete) throw new Error('目录没有读取完整，请先重试读取');
  const { host, token, apiBase } = parseWikiUrl(targetUrl);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO migrations (export_id, target_url, target_host, api_base, target_token, phase, created_at)
       VALUES (?, ?, ?, ?, ?, 'structure', ?)`,
    )
    .run(exportId, targetUrl.trim(), host, apiBase, token, Date.now());
  const id = Number(lastInsertRowid);
  const insert = db.prepare('INSERT INTO migration_items (migration_id, node_id) VALUES (?, ?)');
  for (const { id: nodeId } of db.prepare('SELECT id FROM nodes WHERE export_id = ?').all(exportId)) {
    insert.run(id, nodeId);
  }
  run(id);
  return id;
}

export function resumeMigration(id) {
  db.prepare(`UPDATE migration_items SET error = NULL WHERE migration_id = ? AND status != 'done'`).run(id);
  db.prepare(`UPDATE migrations SET status = 'running', error = NULL, finished_at = NULL WHERE id = ?`).run(id);
  run(id);
}

function run(id) {
  runMigration(id).catch((err) => {
    db.prepare(`UPDATE migrations SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
      err.message,
      Date.now(),
      id,
    );
  });
}

async function runMigration(id) {
  const job = db.prepare('SELECT * FROM migrations WHERE id = ?').get(id);
  const source = db.prepare('SELECT * FROM exports WHERE id = ?').get(job.export_id);
  const client = clientFor('target', job.api_base);

  const { node: target } = await client.get('/wiki/v2/spaces/get_node', { token: job.target_token });
  db.prepare('UPDATE migrations SET space_id = ? WHERE id = ?').run(target.space_id, id);

  const nodes = db.prepare('SELECT * FROM nodes WHERE export_id = ? ORDER BY position').all(job.export_id);
  const items = new Map(
    db.prepare('SELECT * FROM migration_items WHERE migration_id = ?').all(id).map((item) => [item.node_id, item]),
  );
  const assets = loadAssets(job.export_id);
  const ctx = { client, job, source, spaceId: target.space_id, rootToken: target.node_token, nodes, items, assets };

  // Shortcuts need their origin node to exist, so they go after every real node.
  const ordered = [...nodes.filter((n) => n.node_type !== 'shortcut'), ...nodes.filter((n) => n.node_type === 'shortcut')];
  for (const node of ordered) {
    const item = items.get(node.id);
    if (item.target_node_token) continue;
    try {
      await createNode(ctx, node, item);
    } catch (err) {
      setItem(id, node.id, { status: 'failed', error: err.message });
    }
  }

  db.prepare(`UPDATE migrations SET phase = 'content' WHERE id = ?`).run(id);
  const linkFor = buildLinkMapper(ctx);
  for (const node of nodes) {
    const item = db.prepare('SELECT * FROM migration_items WHERE migration_id = ? AND node_id = ?').get(id, node.id);
    if (item.status === 'done' || item.status === 'placeholder' || !item.target_node_token) continue;
    try {
      await fillNode(ctx, node, item, linkFor);
    } catch (err) {
      setItem(id, node.id, { status: 'failed', error: err.message });
    }
  }

  const failed = db
    .prepare(`SELECT COUNT(*) AS n FROM migration_items WHERE migration_id = ? AND status != 'done'`)
    .get(id).n;
  db.prepare(`UPDATE migrations SET status = ?, phase = NULL, finished_at = ? WHERE id = ?`).run(
    failed ? 'partial' : 'done',
    Date.now(),
    id,
  );
}

function setItem(migrationId, nodeId, fields) {
  const keys = Object.keys(fields);
  db.prepare(
    `UPDATE migration_items SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE migration_id = ? AND node_id = ?`,
  ).run(...keys.map((key) => fields[key]), migrationId, nodeId);
}

function loadAssets(exportId) {
  const byNode = new Map();
  for (const asset of db.prepare('SELECT * FROM assets WHERE export_id = ?').all(exportId)) {
    if (!byNode.has(asset.node_id)) byNode.set(asset.node_id, new Map());
    // resolve() also keeps older rows working, which stored absolute paths.
    byNode.get(asset.node_id).set(`${asset.kind}:${asset.token}`, { ...asset, path: resolve(BLOB_DIR, asset.path) });
  }
  return byNode;
}

function parentOf(ctx, node) {
  if (node.parent_token === null) return ctx.rootToken;
  const parent = ctx.nodes.find((n) => n.node_token === node.parent_token);
  const parentItem = db
    .prepare('SELECT target_node_token FROM migration_items WHERE migration_id = ? AND node_id = ?')
    .get(ctx.job.id, parent.id);
  if (!parentItem?.target_node_token) throw new Error(`上级节点「${parent.title}」未创建成功`);
  return parentItem.target_node_token;
}

async function createNode(ctx, node, item) {
  const parent = parentOf(ctx, node);
  const createWiki = async (objType, extra = {}) => {
    const { node: created } = await ctx.client.post(`/wiki/v2/spaces/${ctx.spaceId}/nodes`, {
      obj_type: objType,
      node_type: 'origin',
      parent_node_token: parent,
      title: node.title,
      ...extra,
    });
    return created;
  };

  let created;
  if (node.node_type === 'shortcut') {
    const origin = ctx.nodes.find((n) => n.node_token === node.origin_node_token);
    if (origin) {
      const { target_node_token: originToken } = db
        .prepare('SELECT target_node_token FROM migration_items WHERE migration_id = ? AND node_id = ?')
        .get(ctx.job.id, origin.id);
      if (!originToken) throw new Error(`快捷方式的原文档「${origin.title}」未创建成功`);
      created = await createWiki(origin.obj_type, { node_type: 'shortcut', origin_node_token: originToken });
    } else {
      created = await createWiki('docx');
    }
  } else if (node.status === 'done' && node.obj_type === 'bitable') {
    created = await createWiki('bitable');
  } else if (node.status === 'done' && node.obj_type === 'sheet') {
    created = await importSheet(ctx, node, parent);
  } else if (node.status === 'done' && node.obj_type === 'file') {
    created = await uploadFile(ctx, node, parent);
  } else {
    // docx, plus failed/unsupported nodes which become placeholders so children keep their parent.
    created = await createWiki('docx');
  }

  setItem(ctx.job.id, node.id, {
    target_node_token: created.node_token,
    target_obj_token: created.obj_token,
    target_obj_type: created.obj_type,
    status: 'created',
  });
  item.target_node_token = created.node_token;
}

async function importSheet(ctx, node, parent) {
  const asset = ctx.assets.get(node.id)?.get(`xlsx:${node.obj_token}`);
  if (!asset) throw new Error('本地没有这个表格的导出文件');
  const buffer = readFileSync(asset.path);
  const fileToken = await ctx.client.upload({
    buffer,
    fileName: asset.file_name,
    parentType: 'ccm_import_open',
    extra: JSON.stringify({ obj_type: 'sheet', file_extension: 'xlsx' }),
  });
  const { ticket } = await ctx.client.post('/drive/v1/import_tasks', {
    file_extension: 'xlsx',
    file_token: fileToken,
    type: 'sheet',
    file_name: node.title,
    point: { mount_type: 1, mount_key: '' },
  });
  let imported;
  for (let attempt = 0; attempt < 120 && !imported; attempt++) {
    const { result } = await ctx.client.get(`/drive/v1/import_tasks/${ticket}`);
    if (result.job_status === 0) imported = result.token;
    else if (result.job_status !== 1 && result.job_status !== 2) {
      throw new Error(`表格导入失败: ${result.job_error_msg || result.job_status}`);
    } else await pollDelay(attempt);
  }
  if (!imported) throw new Error('表格导入超时');
  return moveToWiki(ctx, 'sheet', imported, parent);
}

async function uploadFile(ctx, node, parent) {
  const asset = ctx.assets.get(node.id)?.get(`file:${node.obj_token}`);
  if (!asset) throw new Error('本地没有这个文件');
  const { token: rootFolder } = await ctx.client.get('/drive/explorer/v2/root_folder/meta');
  const fileToken = await ctx.client.upload({
    api: 'files',
    buffer: readFileSync(asset.path),
    fileName: asset.file_name || node.title,
    parentType: 'explorer',
    parentNode: rootFolder,
  });
  return moveToWiki(ctx, 'file', fileToken, parent);
}

async function moveToWiki(ctx, objType, objToken, parent) {
  const moved = await ctx.client.post(`/wiki/v2/spaces/${ctx.spaceId}/nodes/move_docs_to_wiki`, {
    parent_wiki_token: parent,
    obj_type: objType,
    obj_token: objToken,
  });
  if (moved.task_id) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const { task } = await ctx.client.get(`/wiki/v2/tasks/${moved.task_id}`, { task_type: 'move' });
      const result = task?.move_result?.[0];
      if (result?.status === 0) break;
      if (result && result.status !== 1 && result.status !== undefined) {
        throw new Error(`移动到知识库失败: ${result.status_msg}`);
      }
      await pollDelay(attempt);
    }
  }
  const { node } = await ctx.client.get('/wiki/v2/spaces/get_node', {
    token: objToken,
    obj_type: objType,
  });
  return node;
}

// Builds the source-URL to target-URL mapper used for links between migrated documents.
function buildLinkMapper(ctx) {
  const rows = db
    .prepare(
      `SELECT n.node_token, n.obj_token, i.target_node_token
       FROM migration_items i JOIN nodes n ON n.id = i.node_id
       WHERE i.migration_id = ? AND i.target_node_token IS NOT NULL`,
    )
    .all(ctx.job.id);
  const tokens = new Map();
  for (const row of rows) {
    tokens.set(row.node_token, row.target_node_token);
    if (row.obj_token) tokens.set(row.obj_token, row.target_node_token);
  }
  return (url) => {
    const match = url.match(URL_TOKEN);
    if (!match) return null;
    const mapped = tokens.get(match[1]);
    return mapped ? `${ctx.job.target_host}/wiki/${mapped}` : null;
  };
}

async function fillNode(ctx, node, item, linkFor) {
  const warnings = new Set();
  const warn = (message) => warnings.add(message);
  const assets = ctx.assets.get(node.id) ?? new Map();
  const content = parseJson(node.content);
  let finalStatus = 'done';

  if (node.node_type === 'shortcut') {
    // A shortcut whose origin was migrated is already complete; otherwise createNode made a docx stand-in.
    if (!ctx.nodes.some((n) => n.node_token === node.origin_node_token)) {
      const url = `${ctx.source.host}/wiki/${node.origin_node_token}`;
      await writePlaceholder(ctx, item, `此快捷方式指向迁移范围之外的文档: ${url}`);
      warn('快捷方式指向迁移范围之外的文档，已替换为说明文档');
    }
  } else if (node.status === 'done' && node.obj_type === 'docx') {
    await writeDocx({
      client: ctx.client,
      documentId: item.target_obj_token,
      content,
      assets,
      linkFor,
      warn,
    });
  } else if (node.status === 'done' && node.obj_type === 'bitable') {
    await writeBitable({ client: ctx.client, appToken: item.target_obj_token, content, assets, warn });
  } else if (node.status !== 'done') {
    const url = `${ctx.source.host}/wiki/${node.node_token}`;
    const reason = node.status === 'unsupported' ? `暂不支持迁移 ${node.obj_type} 类型` : `读取失败: ${node.error}`;
    await writePlaceholder(ctx, item, `${reason}。原始文档: ${url}`);
    warn(reason);
    finalStatus = 'placeholder';
  }

  setItem(ctx.job.id, node.id, {
    status: finalStatus,
    error: null,
    warnings: JSON.stringify([...warnings, ...(parseJson(node.warnings, []))]),
  });
}

async function writePlaceholder(ctx, item, message) {
  await ctx.client.post(
    `/docx/v1/documents/${item.target_obj_token}/blocks/${item.target_obj_token}/children`,
    {
      index: 0,
      children: [{ block_type: 2, text: { elements: [{ text_run: { content: `⚠️ ${message}` } }] } }],
    },
    { document_revision_id: -1 },
  );
}

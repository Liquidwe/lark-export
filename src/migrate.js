// Writes a stored export under a target wiki node: structure first, then content.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clientForJob } from './auth.js';
import { BLOB_DIR, db, parseJson } from './db.js';
import { appConfig, clientFor, concurrencyFromEnv, documentHost, limiter, mapConcurrent, parseWikiUrl, pollDelay } from './lark.js';
import { writeBitable } from './bitable-writer.js';
import { writeDocx } from './docx-writer.js';

const URL_TOKEN = /\/(?:wiki|docx|docs|sheets|base|bitable|file|mindnote|slides)\/([A-Za-z0-9]+)/;
const MY_LIBRARY = 'my_library';
const TITLE_ATTEMPTS = 5;
const TITLE_SETTLE_MS = 2000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeConcurrency = () => concurrencyFromEnv('WRITE_CONCURRENCY', 6, 16);
// What each running migration is doing right now. Only for display, so it need not survive a restart.
const live = new Map();

function assertReadFinished(exportId) {
  const job = db.prepare('SELECT * FROM exports WHERE id = ?').get(exportId);
  if (!job) throw new Error('找不到这次读取记录');
  if (job.status === 'running' || job.status === 'pausing') throw new Error('读取尚未完成');
  if (!job.tree_complete) throw new Error('目录没有读取完整，请先重试读取');
  // Unread nodes would otherwise be migrated as placeholders, as if their read had failed.
  const unread = db
    .prepare(`SELECT COUNT(*) AS n FROM nodes WHERE export_id = ? AND status IN ('pending', 'reading')`)
    .get(exportId).n;
  if (unread) throw new Error(`还有 ${unread} 个文档没有读取完，请先继续读取`);
}

export function startMigration(exportId, targetUrl) {
  assertReadFinished(exportId);
  const { host, token, apiBase } = parseWikiUrl(targetUrl);
  assertTargetOutsideSource(exportId, token);
  return createMigration(exportId, targetUrl.trim(), host, apiBase, token);
}

// Writes a member's read to their own library in the new organization, as top-level nodes.
export function startLibraryMigration(exportId) {
  assertReadFinished(exportId);
  const busy = db
    .prepare(`SELECT id FROM migrations WHERE export_id = ? AND status IN ('running', 'pausing') LIMIT 1`)
    .get(exportId);
  if (busy) throw new Error('迁移正在进行中');
  const { apiBase, host } = appConfig('target');
  return createMigration(exportId, '', host, apiBase, MY_LIBRARY);
}

function createMigration(exportId, targetUrl, host, apiBase, token) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO migrations (export_id, target_url, target_host, api_base, target_token, phase, created_at)
       VALUES (?, ?, ?, ?, ?, 'structure', ?)`,
    )
    .run(exportId, targetUrl, host, apiBase, token, Date.now());
  const id = Number(lastInsertRowid);
  const insert = db.prepare('INSERT INTO migration_items (migration_id, node_id) VALUES (?, ?)');
  for (const { id: nodeId } of db.prepare('SELECT id FROM nodes WHERE export_id = ?').all(exportId)) {
    insert.run(id, nodeId);
  }
  run(id);
  return id;
}

function assertTargetOutsideSource(exportId, token) {
  const inside = db.prepare('SELECT title FROM nodes WHERE export_id = ? AND node_token = ?').get(exportId, token);
  // The target's body gets overwritten, so this would destroy the very document being migrated.
  if (inside) throw new Error(`目标是源目录中的文档「${inside.title}」，请换一个目录之外的位置`);
}

// The target takes on the source root's title and body, and children go directly under it.
// That only works doc to doc: a wiki node cannot change type.
function rootBecomesTarget(root, target) {
  return root.status === 'done' && root.obj_type === 'docx' && root.node_type !== 'shortcut' && target?.obj_type === 'docx';
}

// Describes what a migration would do to the target, so it can be confirmed before anything is overwritten.
export async function previewMigration(exportId, targetUrl) {
  const { token, apiBase } = parseWikiUrl(targetUrl);
  assertTargetOutsideSource(exportId, token);
  const client = clientFor('target', apiBase);
  const { node: target } = await client.get('/wiki/v2/spaces/get_node', { token });
  const root = db.prepare('SELECT * FROM nodes WHERE export_id = ? AND parent_token IS NULL').get(exportId);
  if (!root) throw new Error('目录没有读取完整，请先重试读取');
  const children = target.has_child
    ? await client.all(`/wiki/v2/spaces/${target.space_id}/nodes`, { parent_node_token: target.node_token, page_size: 50 })
    : [];
  const overwrite = rootBecomesTarget(root, target);
  let bodyBlocks = 0;
  if (overwrite) {
    const blocks = await client.all(`/docx/v1/documents/${target.obj_token}/blocks`, { page_size: 500 });
    bodyBlocks = blocks.filter(hasContent).length;
  }
  return { overwrite, targetTitle: target.title, rootTitle: root.title, rootType: root.obj_type, targetType: target.obj_type, childCount: children.length, bodyBlocks };
}

// A new document holds one empty line, which is not worth warning about.
function hasContent(block) {
  if (block.block_type === 1) return false;
  return block.block_type !== 2 || block.text?.elements?.some((e) => e.text_run?.content !== '');
}

// Stops before the next node. The node in progress finishes, then the run settles as paused.
export function pauseMigration(id) {
  const { changes } = db.prepare(`UPDATE migrations SET status = 'pausing' WHERE id = ? AND status = 'running'`).run(id);
  if (!changes) throw new Error('迁移没有在进行中');
}

export function resumeMigration(id) {
  const job = db.prepare('SELECT status FROM migrations WHERE id = ?').get(id);
  if (!job) throw new Error('找不到这次迁移记录');
  if (job.status === 'running' || job.status === 'pausing') throw new Error('迁移还在进行中，请等它停下后再继续');
  // Failed nodes go back in line, so while waiting they neither show as failed nor count as finished.
  db.prepare(
    `UPDATE migration_items SET status = CASE WHEN target_node_token IS NULL THEN 'pending' ELSE 'created' END
     WHERE migration_id = ? AND status = 'failed'`,
  ).run(id);
  db.prepare(`UPDATE migration_items SET error = NULL WHERE migration_id = ? AND status != 'done'`).run(id);
  db.prepare(`UPDATE migrations SET status = 'running', error = NULL, finished_at = NULL WHERE id = ?`).run(id);
  run(id);
}

function run(id) {
  const startedAt = Date.now();
  live.set(id, { startedAt, phaseStartedAt: startedAt, phaseBaseline: 0, active: new Map(), concurrency: writeConcurrency() });
  runMigration(id)
    .catch((err) => {
      db.prepare(`UPDATE migrations SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
        err.message,
        Date.now(),
        id,
      );
    })
    .finally(() => {
      db.prepare('UPDATE migrations SET active_ms = active_ms + ? WHERE id = ?').run(Date.now() - startedAt, id);
      live.delete(id);
    });
}

const structureDone = (items) => items.filter((item) => item.target_node_token || item.status === 'failed').length;
const contentDone = (items) => items.filter((item) => ['done', 'placeholder', 'failed'].includes(item.status)).length;

function enterPhase(id, phase) {
  db.prepare('UPDATE migrations SET phase = ? WHERE id = ?').run(phase, id);
  const items = db.prepare('SELECT target_node_token, status FROM migration_items WHERE migration_id = ?').all(id);
  Object.assign(live.get(id), {
    phaseStartedAt: Date.now(),
    phaseBaseline: phase === 'content' ? contentDone(items) : structureDone(items),
  });
}

// Reports one node's work as live, and adds the time it took to that node.
async function track(ctx, node, step, work) {
  const state = live.get(ctx.job.id);
  const entry = { step, done: null, total: null, startedAt: Date.now() };
  state.active.set(node.id, entry);
  try {
    return await work((nextStep, done = null, total = null) => Object.assign(entry, { step: nextStep, done, total }));
  } finally {
    state.active.delete(node.id);
    db.prepare('UPDATE migration_items SET duration_ms = duration_ms + ? WHERE migration_id = ? AND node_id = ?').run(
      Date.now() - entry.startedAt,
      ctx.job.id,
      node.id,
    );
  }
}

// Everything the page shows about a migration's progress. items come from the caller's query.
export function migrationProgress(job, items) {
  const state = live.get(job.id);
  const now = Date.now();
  const titles = new Map(items.map((item) => [item.node_id, item]));
  const byType = {};
  for (const item of items) {
    byType[item.obj_type] ??= { total: 0, done: 0 };
    byType[item.obj_type].total++;
    if (['done', 'placeholder', 'failed'].includes(item.status)) byType[item.obj_type].done++;
  }
  const structure = structureDone(items);
  const content = contentDone(items);
  const result = {
    structure,
    content,
    byType,
    elapsedMs: job.active_ms + (state ? now - state.startedAt : 0),
    active: [],
    ratePerSecond: null,
    etaMs: null,
    concurrency: null,
  };
  if (!state) return result;
  result.concurrency = state.concurrency;
  result.active = [...state.active]
    .sort((a, b) => a[1].startedAt - b[1].startedAt)
    .map(([nodeId, entry]) => ({
      nodeId,
      title: titles.get(nodeId)?.title,
      objType: titles.get(nodeId)?.obj_type,
      step: entry.step,
      done: entry.done,
      total: entry.total,
      ms: now - entry.startedAt,
    }));
  const current = job.phase === 'content' ? content : structure;
  const finished = current - state.phaseBaseline;
  // A few nodes are too few to extrapolate from, since documents differ widely in size.
  if (finished >= 3) {
    const rate = finished / (now - state.phaseStartedAt);
    result.ratePerSecond = rate * 1000;
    result.etaMs = (items.length - current) / rate;
  }
  return result;
}

async function runMigration(id) {
  const job = db.prepare('SELECT * FROM migrations WHERE id = ?').get(id);
  const source = db.prepare('SELECT * FROM exports WHERE id = ?').get(job.export_id);
  const client = clientForJob('target', { owner_id: source.owner_id, api_base: job.api_base });

  // A library has no node to merge into, so its target and root token stay empty.
  const toLibrary = job.target_token === MY_LIBRARY;
  const target = toLibrary ? null : (await client.get('/wiki/v2/spaces/get_node', { token: job.target_token })).node;
  const spaceId = toLibrary ? (await client.get(`/wiki/v2/spaces/${MY_LIBRARY}`)).space.space_id : target.space_id;
  db.prepare('UPDATE migrations SET space_id = ? WHERE id = ?').run(spaceId, id);

  const nodes = db.prepare('SELECT * FROM nodes WHERE export_id = ? ORDER BY position').all(job.export_id);
  const items = new Map(
    db.prepare('SELECT * FROM migration_items WHERE migration_id = ?').all(id).map((item) => [item.node_id, item]),
  );
  const assets = loadAssets(job.export_id);
  const ctx = { client, job, source, target, spaceId, rootToken: target?.node_token ?? null, nodes, items, assets };

  const isPausing = () => db.prepare('SELECT status FROM migrations WHERE id = ?').get(id).status === 'pausing';
  const concurrency = live.get(id).concurrency;

  enterPhase(id, 'structure');
  await createStructure(ctx, concurrency, isPausing);

  enterPhase(id, 'content');
  if (toLibrary) await learnTargetHost(ctx);
  const linkFor = buildLinkMapper(ctx);
  // Documents are independent once their nodes exist. Each is still written by one worker,
  // because its blocks are positioned by index.
  await mapConcurrent(
    nodes,
    concurrency,
    async (node) => {
      const item = db.prepare('SELECT * FROM migration_items WHERE migration_id = ? AND node_id = ?').get(id, node.id);
      if (item.status === 'done' || item.status === 'placeholder' || !item.target_node_token) return;
      try {
        await track(ctx, node, '等待写入', (progress) => fillNode(ctx, node, item, linkFor, progress));
      } catch (err) {
        setItem(id, node.id, { status: 'failed', error: err.message });
      }
    },
    { shouldStop: isPausing },
  );
  await confirmRootTitle(ctx);

  const count = (statuses) =>
    db
      .prepare(`SELECT COUNT(*) AS n FROM migration_items WHERE migration_id = ? AND status IN (${statuses})`)
      .get(id).n;
  let status = count(`'pending', 'created', 'failed', 'placeholder'`) ? 'partial' : 'done';
  if (isPausing() && count(`'pending', 'created'`)) status = 'paused';
  db.prepare(`UPDATE migrations SET status = ?, phase = NULL, finished_at = ? WHERE id = ?`).run(status, Date.now(), id);
}

// A wiki node joins the end of its parent's children, so siblings are created one at a time
// to keep their order. Separate parents can run side by side.
async function learnTargetHost(ctx) {
  const row = db
    .prepare(
      `SELECT target_obj_token AS obj_token, target_obj_type AS obj_type FROM migration_items
       WHERE migration_id = ? AND target_obj_token IS NOT NULL LIMIT 1`,
    )
    .get(ctx.job.id);
  if (!row) return;
  ctx.job.target_host = await documentHost(ctx.client, row, ctx.job.target_host);
  db.prepare('UPDATE migrations SET target_host = ? WHERE id = ?').run(ctx.job.target_host, ctx.job.id);
}

async function createStructure(ctx, concurrency, isPausing) {
  const slot = limiter(concurrency);
  const reached = new Set();
  const create = async (node) => {
    const item = ctx.items.get(node.id);
    if (item.target_node_token) return;
    try {
      await track(ctx, node, createStep(node), () => createNode(ctx, node, item));
    } catch (err) {
      setItem(ctx.job.id, node.id, { status: 'failed', error: err.message });
    }
  };

  const real = ctx.nodes.filter((node) => node.node_type !== 'shortcut');
  const children = Map.groupBy(real, (node) => node.parent_token);
  const walk = async (parentToken) => {
    const branches = [];
    for (const node of children.get(parentToken) ?? []) {
      if (isPausing()) break;
      reached.add(node.id);
      await slot(async () => {
        if (!isPausing()) await create(node);
      });
      branches.push(walk(node.node_token));
    }
    await Promise.all(branches);
  };
  await walk(null);

  // Shortcuts need their origin node to exist, so they go after every real node,
  // along with anything that hangs below a shortcut rather than a real node.
  for (const node of [...real, ...ctx.nodes.filter((n) => n.node_type === 'shortcut')]) {
    if (isPausing()) break;
    if (!reached.has(node.id)) await create(node);
  }
}

// Lark sometimes answers a rename with success, updates the document's page block, and leaves the
// wiki title behind (6 of 30 on the live API). Sending the same title again then does nothing
// (0 of 3 fixed), because it matches the page block; going through another title does (6 of 6).
// So the title is read back once nothing else is writing to the document.
async function confirmRootTitle(ctx) {
  if (!ctx.rootToken) return;
  const root = ctx.nodes.find((node) => node.parent_token === null);
  if (ctx.items.get(root?.id)?.target_node_token !== ctx.rootToken) return;
  for (let attempt = 0; attempt < TITLE_ATTEMPTS; attempt++) {
    const { node } = await ctx.client.get('/wiki/v2/spaces/get_node', { token: ctx.rootToken });
    if (node.title === root.title) return;
    const rename = `/wiki/v2/spaces/${ctx.spaceId}/nodes/${ctx.rootToken}/update_title`;
    await ctx.client.post(rename, { title: `${root.title}…` });
    await ctx.client.post(rename, { title: root.title });
    await sleep(TITLE_SETTLE_MS);
  }
  const { node } = await ctx.client.get('/wiki/v2/spaces/get_node', { token: ctx.rootToken });
  if (node.title === root.title) return;
  const { warnings } = db
    .prepare('SELECT warnings FROM migration_items WHERE migration_id = ? AND node_id = ?')
    .get(ctx.job.id, root.id);
  setItem(ctx.job.id, root.id, {
    warnings: JSON.stringify([...parseJson(warnings, []), `目标文档没能改名为「${root.title}」，请在 Lark 中手动修改标题`]),
  });
}

function createStep(node) {
  if (node.status === 'done' && node.obj_type === 'sheet') return '导入电子表格';
  if (node.status === 'done' && node.obj_type === 'file') return '上传文件';
  return '新建节点';
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
  // Null for a library, where leaving the parent out places a node at the top level.
  if (node.parent_token === null) return ctx.rootToken ?? undefined;
  const parent = ctx.nodes.find((n) => n.node_token === node.parent_token);
  const parentItem = db
    .prepare('SELECT target_node_token FROM migration_items WHERE migration_id = ? AND node_id = ?')
    .get(ctx.job.id, parent.id);
  if (!parentItem?.target_node_token) throw new Error(`上级节点「${parent.title}」未创建成功`);
  return parentItem.target_node_token;
}

async function createNode(ctx, node, item) {
  if (node.parent_token === null && rootBecomesTarget(node, ctx.target)) {
    await ctx.client.post(`/wiki/v2/spaces/${ctx.spaceId}/nodes/${ctx.rootToken}/update_title`, { title: node.title });
    setItem(ctx.job.id, node.id, {
      target_node_token: ctx.target.node_token,
      target_obj_token: ctx.target.obj_token,
      target_obj_type: ctx.target.obj_type,
      status: 'created',
    });
    item.target_node_token = ctx.target.node_token;
    return;
  }
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

async function fillNode(ctx, node, item, linkFor, progress) {
  const warnings = new Set();
  const warn = (message) => warnings.add(message);
  const assets = ctx.assets.get(node.id) ?? new Map();
  const content = parseJson(node.content);
  let finalStatus = 'done';
  if (ctx.rootToken && node.parent_token === null && item.target_node_token !== ctx.rootToken) {
    warn(`源文档是${node.obj_type}类型，无法合并到目标文档，已放在目标节点下面`);
  }

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
      progress,
    });
  } else if (node.status === 'done' && node.obj_type === 'bitable') {
    await writeBitable({ client: ctx.client, appToken: item.target_obj_token, content, assets, warn, progress });
  } else if (node.status !== 'done') {
    progress('写入占位文档');
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

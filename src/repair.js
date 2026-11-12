// Puts back extension blocks, such as Mermaid diagrams, in documents migrated before they were
// supported. Those migrations wrote a placeholder line in place of each one, so the source's
// diagrams can go back exactly where they were, without migrating the documents again.

import { randomUUID } from 'node:crypto';
import { db, parseJson } from './db.js';
import { ADDON_LABEL, placeholderText } from './docx-writer.js';
import { clientFor, concurrencyFromEnv, mapConcurrent, parseWikiUrl } from './lark.js';

const PLACEHOLDER = placeholderText(ADDON_LABEL);
const ADD_ON = 40;
const readConcurrency = () => concurrencyFromEnv('READ_CONCURRENCY', 8, 32);
const writeConcurrency = () => concurrencyFromEnv('WRITE_CONCURRENCY', 6, 16);

// Compares two trees and lists the documents whose diagrams are missing. Nothing is written.
export function startRepair(sourceUrl, targetUrl) {
  const source = parseWikiUrl(sourceUrl);
  const target = parseWikiUrl(targetUrl);
  if (source.token === target.token) throw new Error('源链接和目标链接是同一个文档');
  const busy = db.prepare(`SELECT id FROM repairs WHERE status IN ('scanning', 'applying') LIMIT 1`).get();
  if (busy) throw new Error('已有一个补全任务在进行中，请等它结束');
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO repairs (source_url, target_url, status, docs, progress, created_at)
       VALUES (?, ?, 'scanning', '[]', ?, ?)`,
    )
    .run(sourceUrl.trim(), targetUrl.trim(), JSON.stringify({ paired: 0, checked: 0, unmatched: [] }), Date.now());
  const id = Number(lastInsertRowid);
  settle(id, scan(id, source, target));
  return id;
}

// Adds the diagrams to every document whose placeholders line up with the source.
export function applyRepair(id) {
  const job = getRepair(id);
  if (job.status !== 'scanned' && job.status !== 'partial') throw new Error('请等对比完成后再补全');
  const docs = parseJson(job.docs, []);
  if (!docs.some((doc) => doc.state === 'missing' || doc.state === 'failed')) throw new Error('没有需要补全的文档');
  db.prepare(`UPDATE repairs SET status = 'applying', error = NULL, finished_at = NULL WHERE id = ?`).run(id);
  settle(id, apply(id, job, docs));
}

export function listRepairs() {
  return db
    .prepare('SELECT * FROM repairs ORDER BY id DESC LIMIT 10')
    .all()
    .map((job) => ({ ...job, docs: parseJson(job.docs, []), progress: parseJson(job.progress, {}) }));
}

function getRepair(id) {
  const job = db.prepare('SELECT * FROM repairs WHERE id = ?').get(id);
  if (!job) throw new Error('找不到这个补全任务');
  return job;
}

function settle(id, work) {
  work
    .then((status) => db.prepare('UPDATE repairs SET status = ?, finished_at = ? WHERE id = ?').run(status, Date.now(), id))
    .catch((err) =>
      db
        .prepare(`UPDATE repairs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
        .run(err.message, Date.now(), id),
    );
}

async function scan(id, sourceLink, targetLink) {
  const source = clientFor('source', sourceLink.apiBase);
  const target = clientFor('target', targetLink.apiBase);
  const [{ node: sourceRoot }, { node: targetRoot }] = await Promise.all([
    source.get('/wiki/v2/spaces/get_node', { token: sourceLink.token }),
    target.get('/wiki/v2/spaces/get_node', { token: targetLink.token }),
  ]);
  const progress = { paired: 0, checked: 0, unmatched: [] };
  const docs = [];
  const save = () =>
    db.prepare('UPDATE repairs SET docs = ?, progress = ? WHERE id = ?').run(JSON.stringify(docs), JSON.stringify(progress), id);

  // The two roots are paired whatever their titles; below them, children pair by title.
  const pairs = [];
  let level = [{ source: sourceRoot, target: targetRoot, path: sourceRoot.title }];
  while (level.length) {
    pairs.push(...level);
    progress.paired += level.length;
    save();
    const next = [];
    await mapConcurrent(level, readConcurrency(), async (pair) => {
      if (!pair.source.has_child) return;
      const [sourceKids, targetKids] = await Promise.all([children(source, pair.source), children(target, pair.target)]);
      for (const { source: kid, target: match } of matchByTitle(sourceKids, targetKids)) {
        if (match) next.push({ source: kid, target: match, path: `${pair.path} / ${kid.title}` });
        else progress.unmatched.push(`${pair.path} / ${kid.title}`);
      }
    });
    level = next;
  }

  const documents = pairs.filter((pair) => pair.source.obj_type === 'docx' && pair.target.obj_type === 'docx');
  await mapConcurrent(documents, readConcurrency(), async (pair) => {
    try {
      const sourceBlocks = inOrder(await blocksOf(source, pair.source.obj_token));
      const diagrams = sourceBlocks.filter((block) => block.block_type === ADD_ON);
      if (diagrams.length) {
        const { slots } = await slotsOf(target, pair.target.obj_token);
        docs.push(describe(pair, sourceLink.host, targetLink.host, diagrams, slots));
      }
    } catch (err) {
      docs.push({ ...docOf(pair, sourceLink.host, targetLink.host), state: 'failed', error: err.message });
    }
    progress.checked++;
    save();
  });
  docs.sort((a, b) => a.path.localeCompare(b.path, 'zh'));
  save();
  return 'scanned';
}

async function apply(id, job, docs) {
  const sourceLink = parseWikiUrl(job.source_url);
  const targetLink = parseWikiUrl(job.target_url);
  const source = clientFor('source', sourceLink.apiBase);
  const target = clientFor('target', targetLink.apiBase);
  const save = () => db.prepare('UPDATE repairs SET docs = ? WHERE id = ?').run(JSON.stringify(docs), id);
  const todo = docs.filter((doc) => doc.state === 'missing' || doc.state === 'failed');

  await mapConcurrent(todo, writeConcurrency(), async (doc) => {
    doc.state = 'applying';
    doc.error = null;
    doc.restored ??= 0;
    save();
    try {
      // Read again, since either side may have changed since the comparison.
      const diagrams = inOrder(await blocksOf(source, doc.sourceObj)).filter((block) => block.block_type === ADD_ON);
      const { slots, parents } = await slotsOf(target, doc.targetObj);
      Object.assign(doc, counts(diagrams, slots));
      if (slots.length !== diagrams.length) {
        doc.state = 'mismatch';
      } else {
        for (const [i, slot] of slots.entries()) {
          if (slot.block_type === ADD_ON) continue;
          await replacePlaceholder(target, doc.targetObj, parents.get(slot.block_id), slot, diagrams[i]);
          doc.restored++;
          doc.missing--;
          save();
        }
        doc.state = 'fixed';
      }
    } catch (err) {
      doc.state = 'failed';
      doc.error = err.message;
    }
    save();
  });
  return docs.some((doc) => doc.state === 'failed') ? 'partial' : 'done';
}

// The diagram goes in where the placeholder is, then the placeholder (now one further down) goes.
async function replacePlaceholder(client, documentId, parent, placeholder, diagram) {
  const index = parent?.children.indexOf(placeholder.block_id) ?? -1;
  if (index < 0) throw new Error('找不到占位行的位置');
  await client.post(
    `/docx/v1/documents/${documentId}/blocks/${parent.block_id}/descendant`,
    {
      children_id: ['diagram'],
      index,
      descendants: [
        {
          block_id: 'diagram',
          block_type: ADD_ON,
          add_ons: { component_type_id: diagram.add_ons.component_type_id, record: diagram.add_ons.record },
        },
      ],
    },
    { document_revision_id: -1, client_token: randomUUID() },
  );
  await client.request('DELETE', `/docx/v1/documents/${documentId}/blocks/${parent.block_id}/children/batch_delete`, {
    body: { start_index: index + 1, end_index: index + 2 },
    query: { document_revision_id: -1 },
  });
  parent.children.splice(index + 1, 1);
  parent.children.splice(index, 1, 'diagram');
}

// Each source diagram became either a diagram (already restored) or a placeholder, in the same order.
async function slotsOf(client, documentId) {
  const blocks = await blocksOf(client, documentId);
  const slots = inOrder(blocks).filter((block) => block.block_type === ADD_ON || isPlaceholder(block));
  // Parents come from the children lists, which are what the positions below are counted in.
  const parents = new Map();
  for (const block of blocks) for (const child of block.children ?? []) parents.set(child, block);
  return { slots, parents };
}

function isPlaceholder(block) {
  if (block.block_type !== 2) return false;
  return (block.text?.elements ?? []).map((e) => e.text_run?.content ?? '').join('') === PLACEHOLDER;
}

function describe(pair, sourceHost, targetHost, diagrams, slots) {
  const doc = { ...docOf(pair, sourceHost, targetHost), ...counts(diagrams, slots), restored: 0, error: null };
  if (slots.length !== diagrams.length) doc.state = 'mismatch';
  else doc.state = doc.missing ? 'missing' : 'complete';
  return doc;
}

function counts(diagrams, slots) {
  return { diagrams: diagrams.length, missing: slots.filter((slot) => slot.block_type !== ADD_ON).length, slots: slots.length };
}

function docOf(pair, sourceHost, targetHost) {
  return {
    path: pair.path,
    sourceObj: pair.source.obj_token,
    targetObj: pair.target.obj_token,
    sourceUrl: `${sourceHost}/wiki/${pair.source.node_token}`,
    targetUrl: `${targetHost}/wiki/${pair.target.node_token}`,
  };
}

// Same titles pair up in order, so two children named alike still find their own counterparts.
export function matchByTitle(sourceKids, targetKids) {
  const unused = [...targetKids];
  return sourceKids.map((kid) => {
    const at = unused.findIndex((other) => other.title === kid.title);
    return { source: kid, target: at < 0 ? null : unused.splice(at, 1)[0] };
  });
}

function children(client, node) {
  return client.all(`/wiki/v2/spaces/${node.space_id}/nodes`, { parent_node_token: node.node_token, page_size: 50 });
}

function blocksOf(client, documentId) {
  return client.all(`/docx/v1/documents/${documentId}/blocks`, { page_size: 500, document_revision_id: -1 });
}

// Blocks in reading order, following each block's children from the page down.
export function inOrder(blocks) {
  const byId = new Map(blocks.map((block) => [block.block_id, block]));
  const page = blocks.find((block) => block.block_type === 1);
  const out = [];
  const visit = (block) => {
    out.push(block);
    for (const child of block.children ?? []) if (byId.has(child)) visit(byId.get(child));
  };
  if (page) visit(page);
  return out;
}

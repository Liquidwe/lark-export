// Rebuilds a docx block tree from stored source blocks in a target document.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeEmbeddedTable } from './bitable-writer.js';
import { columnName } from './lark.js';

const BLOCK_NAMES = {
  2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 7: 'heading5',
  8: 'heading6', 9: 'heading7', 10: 'heading8', 11: 'heading9', 12: 'bullet', 13: 'ordered',
  14: 'code', 15: 'quote', 17: 'todo', 19: 'callout', 22: 'divider', 24: 'grid',
  18: 'bitable', 25: 'grid_column', 26: 'iframe', 27: 'image', 23: 'file', 30: 'sheet', 31: 'table',
  32: 'table_cell', 33: 'view', 34: 'quote_container', 43: 'board',
};
const TEXT_LIKE = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17]);
const UNSUPPORTED_LABELS = {
  20: '群名片', 21: '流程图', 28: '第三方小组件', 29: '思维笔记',
  35: '任务', 36: 'OKR', 40: '扩展组件', 999: '未知内容',
};
const MAX_BLOCKS_PER_CALL = 500;
const MAX_ROOTS_PER_CALL = 50;
// Lark caps blocks that allocate a resource per request (code 1770035); 21 boards exceeded it.
const RESOURCE_BLOCKS = new Set([18, 23, 27, 30, 43]);
const MAX_RESOURCES_PER_CALL = 5;
// Lark refuses these when they have no children (code 1770041), so they get an empty line.
const NEEDS_CHILD = new Set([19, 25, 32, 34]);
// Codes meaning Lark rejected the content itself. Retrying as is cannot help, but the rest
// of the document is still writable. Measured by sending each shape to the live API.
const REJECTED_CONTENT_CODES = new Set([1770001, 1770006, 1770030, 1770041, 4000027, 99992402]);
const MAX_TEXT_LENGTH = 100000;
const MAX_PLAIN_LINES_PER_CALL = 500;

// linkFor maps a source URL or token to its migrated location; warn collects fidelity losses.
export async function writeDocx({ client, documentId, content, assets, linkFor, warn }) {
  const byId = new Map(content.blocks.map((block) => [block.block_id, block]));
  const page = content.blocks.find((block) => block.block_type === 1);
  if (!page) return;

  // The target doc was created by this migration, so clearing it makes a retry safe.
  const { block: targetPage } = await client.get(`/docx/v1/documents/${documentId}/blocks/${documentId}`);
  if (targetPage.children?.length) {
    await client.request('DELETE', `/docx/v1/documents/${documentId}/blocks/${documentId}/children/batch_delete`, {
      body: { start_index: 0, end_index: targetPage.children.length },
      query: { document_revision_id: -1 },
    });
  }

  const descendants = new Map();
  const uploads = [];
  const merges = [];
  const sheets = [];
  const boards = [];
  const bitables = [];

  const convert = (sourceId) => {
    const source = byId.get(sourceId);
    if (!source) return null;
    const block = toTargetBlock(source, { linkFor, warn, assets, uploads, merges, sheets, boards, bitables, content });
    const children = block.__leaf ? [] : (source.children || []).map(convert).filter(Boolean);
    delete block.__leaf;
    if (!children.length && NEEDS_CHILD.has(block.block_type)) {
      const filler = emptyLine(`${block.block_id}-empty`);
      descendants.set(filler.block_id, filler);
      children.push(filler.block_id);
    }
    if (children.length) block.children = children;
    descendants.set(block.block_id, block);
    return block.block_id;
  };
  const roots = (page.children || []).map(convert).filter(Boolean);

  const relations = new Map();
  let index = 0;
  const create = async (rootIds, blocks) => {
    const data = await client.post(
      `/docx/v1/documents/${documentId}/blocks/${documentId}/descendant`,
      { children_id: rootIds, index, descendants: blocks },
      { document_revision_id: -1, client_token: randomUUID() },
    );
    for (const relation of data.block_id_relations || []) {
      relations.set(relation.temporary_block_id, relation.block_id);
    }
    index += rootIds.length;
  };
  // Narrows a rejected batch down to the block responsible, so one bad block cannot sink
  // the whole document. That block alone is kept as plain text.
  const write = async (batch) => {
    try {
      await create(batch.roots, batch.blocks);
    } catch (err) {
      if (!REJECTED_CONTENT_CODES.has(err.code)) throw err;
      if (batch.roots.length > 1) {
        const middle = Math.ceil(batch.roots.length / 2);
        for (const part of [batch.roots.slice(0, middle), batch.roots.slice(middle)]) {
          await write({ roots: part, blocks: part.flatMap((root) => collect(root, descendants)) });
        }
        return;
      }
      const lines = plainTextBlocks(batch.blocks, batch.roots[0]);
      warn(`有内容块写入被拒绝 (code=${err.code})，已转为纯文本，原有格式和其中的图片、附件未保留`);
      for (let i = 0; i < lines.length; i += MAX_PLAIN_LINES_PER_CALL) {
        const part = lines.slice(i, i + MAX_PLAIN_LINES_PER_CALL);
        await create(part.map((line) => line.block_id), part);
      }
    }
  };
  for (const batch of batchRoots(roots, descendants)) await write(batch);

  for (const upload of uploads) await applyUpload({ client, documentId, relations, upload, assets, warn });
  for (const merge of merges) await applyMerge({ client, documentId, relations, merge, warn });
  for (const sheet of sheets) await fillEmbeddedSheet({ client, documentId, relations, sheet, warn });
  const fillErrors = [];
  for (const board of boards) {
    try {
      await fillBoard({ client, documentId, relations, board, assets, warn });
    } catch (err) {
      fillErrors.push(`画板: ${err.message}`);
    }
  }
  for (const bitable of bitables) {
    try {
      await fillEmbeddedBitable({ client, documentId, relations, bitable, assets, warn });
    } catch (err) {
      fillErrors.push(`内嵌多维表格: ${err.message}`);
    }
  }
  if (fillErrors.length) {
    throw new Error(`${fillErrors.length} 个内容写入失败: ${[...new Set(fillErrors)].join('; ')}`);
  }
}

async function fillEmbeddedBitable({ client, documentId, relations, bitable, assets, warn }) {
  const blockId = relations.get(bitable.id);
  if (!blockId) return;
  const { block } = await client.get(`/docx/v1/documents/${documentId}/blocks/${blockId}`);
  const separator = block.bitable.token.lastIndexOf('_');
  await writeEmbeddedTable({
    client,
    appToken: block.bitable.token.slice(0, separator),
    tableId: block.bitable.token.slice(separator + 1),
    table: bitable.table,
    assets,
    warn,
  });
}

function emptyLine(id) {
  return { block_id: id, block_type: 2, text: { elements: [{ text_run: { content: '' } }] } };
}

function blockText(block) {
  const elements = block[BLOCK_NAMES[block.block_type]]?.elements ?? [];
  return elements.map((e) => e.text_run?.content ?? e.equation?.content ?? '').join('');
}

// One line per row, so a table too big to create can still be read as a table.
function tableRows(table, byId) {
  const cells = (table.children ?? []).map((cellId) => {
    const cell = byId.get(cellId);
    return (cell?.children ?? []).map((id) => blockText(byId.get(id) ?? {})).filter(Boolean).join(' ');
  });
  const width = table.table.property.column_size;
  const rows = [];
  for (let i = 0; i < cells.length; i += width) rows.push(cells.slice(i, i + width).join(' | '));
  return rows;
}

function plainTextBlocks(blocks, rootId) {
  const byId = new Map(blocks.map((block) => [block.block_id, block]));
  const root = byId.get(rootId);
  const raw = root.block_type === 31 ? tableRows(root, byId) : blocks.map(blockText);
  const texts = raw
    .filter(Boolean)
    .flatMap((text) => {
      const parts = [];
      for (let i = 0; i < text.length; i += MAX_TEXT_LENGTH) parts.push(text.slice(i, i + MAX_TEXT_LENGTH));
      return parts;
    });
  const lines = texts.length ? texts : ['[未迁移的内容: 该内容块被 Lark 拒绝写入]'];
  return lines.map((content, i) => ({
    block_id: `${rootId}-plain-${i}`,
    block_type: 2,
    text: { elements: [{ text_run: { content } }] },
  }));
}

async function fillBoard({ client, documentId, relations, board, assets, warn }) {
  const blockId = relations.get(board.id);
  if (!blockId || !board.nodes.length) return;
  const { block } = await client.get(`/docx/v1/documents/${documentId}/blocks/${blockId}`);
  const boardId = block.board.token;

  const nodes = structuredClone(board.nodes);
  for (const node of nodes) {
    if (!node.image?.token) continue;
    const asset = assets.get(`board-image:${node.image.token}`);
    if (!asset) throw new Error('画板中的图片未在本地找到，请重新读取');
    node.image.token = await client.upload({
      buffer: readFileSync(asset.path),
      fileName: asset.file_name || `${node.image.token}.png`,
      parentType: 'whiteboard',
      parentNode: boardId,
    });
  }

  // Lark rejects user IDs from another tenant, and one bad node fails the whole board.
  const stickies = nodes.filter((node) => node.sticky_note);
  if (stickies.length) {
    const info = await (await client.send('GET', '/bot/v3/info')).json();
    for (const node of stickies) {
      node.sticky_note.user_id = info.bot.open_id;
      node.sticky_note.show_author_info = false;
    }
    warn('画板便签的作者无法跨组织保留，已隐藏作者信息');
  }

  // Node references are only remapped within one request, so a board must be written in one batch.
  await client.post(`/board/v1/whiteboards/${boardId}/nodes`, { nodes }, { client_token: randomUUID() });
}

function batchRoots(roots, descendants) {
  const batches = [];
  let current = { roots: [], blocks: [], resources: 0 };
  for (const root of roots) {
    const blocks = collect(root, descendants);
    const resources = blocks.filter((block) => RESOURCE_BLOCKS.has(block.block_type)).length;
    const overflow =
      current.roots.length >= MAX_ROOTS_PER_CALL ||
      current.blocks.length + blocks.length > MAX_BLOCKS_PER_CALL ||
      current.resources + resources > MAX_RESOURCES_PER_CALL;
    if (current.roots.length && overflow) {
      batches.push(current);
      current = { roots: [], blocks: [], resources: 0 };
    }
    current.roots.push(root);
    current.blocks.push(...blocks);
    current.resources += resources;
  }
  if (current.roots.length) batches.push(current);
  return batches;
}

function collect(id, descendants) {
  const block = descendants.get(id);
  return [block, ...(block.children || []).flatMap((child) => collect(child, descendants))];
}

function toTargetBlock(source, ctx) {
  const { block_id: id, block_type: type } = source;
  const name = BLOCK_NAMES[type];

  if (!name) return placeholder(id, UNSUPPORTED_LABELS[type] ?? `类型 ${type} 的内容`, ctx);

  if (TEXT_LIKE.has(type)) {
    const payload = source[name] ?? {};
    const elements = (payload.elements || []).flatMap((element) => convertElement(element, ctx));
    return {
      block_id: id,
      block_type: type,
      [name]: {
        // Lark rejects an empty list (code 1770001), which is what a line holding
        // only a dropped inline element would otherwise become.
        elements: elements.length ? elements : [{ text_run: { content: '' } }],
        style: cleanStyle(payload.style),
      },
    };
  }

  switch (type) {
    case 22:
      return { block_id: id, block_type: type, divider: {} };
    case 19:
      return { block_id: id, block_type: type, callout: source.callout ?? {} };
    case 24:
      return { block_id: id, block_type: type, grid: { column_size: source.grid.column_size } };
    case 25:
      return { block_id: id, block_type: type, grid_column: { width_ratio: source.grid_column.width_ratio } };
    case 26:
      return { block_id: id, block_type: type, iframe: { component: source.iframe.component } };
    case 32:
      return { block_id: id, block_type: type, table_cell: {} };
    case 33:
      return { block_id: id, block_type: type, view: { view_type: source.view?.view_type ?? 1 } };
    case 34:
      return { block_id: id, block_type: type, quote_container: {} };
    case 31: {
      const { row_size, column_size, column_width, header_row, header_column, merge_info } = source.table.property;
      if (merge_info?.some((m) => m.row_span > 1 || m.col_span > 1)) {
        ctx.merges.push({ id, column_size, merge_info });
      }
      return {
        block_id: id,
        block_type: type,
        table: { property: { row_size, column_size, column_width, header_row, header_column } },
      };
    }
    case 27:
      ctx.uploads.push({
        id,
        kind: 'image',
        assetKey: `image:${source.image?.token}`,
        width: source.image?.width,
        height: source.image?.height,
      });
      return { block_id: id, block_type: 27, image: {}, __leaf: true };
    case 18: {
      const table = ctx.content.embeddedBitables?.[id];
      if (!table) return placeholder(id, '内嵌多维表格', ctx);
      ctx.bitables.push({ id, table });
      return { block_id: id, block_type: 18, bitable: { view_type: source.bitable?.view_type ?? 1 }, __leaf: true };
    }
    case 43:
      ctx.boards.push({ id, nodes: ctx.content.boards?.[id] ?? [] });
      return { block_id: id, block_type: 43, board: {}, __leaf: true };
    case 23:
      ctx.uploads.push({ id, kind: 'file', assetKey: `file:${source.file?.token}` });
      return { block_id: id, block_type: 23, file: { token: '' }, __leaf: true };
    case 30: {
      const values = ctx.content.embeddedSheets?.[id] ?? [];
      const row_size = Math.min(Math.max(values.length, 1), 100);
      const column_size = Math.min(Math.max(...values.map((row) => row.length), 1), 100);
      ctx.sheets.push({ id, values });
      return { block_id: id, block_type: 30, sheet: { row_size, column_size }, __leaf: true };
    }
    default:
      return placeholder(id, `类型 ${type} 的内容`, ctx);
  }
}

function placeholder(id, label, ctx) {
  ctx.warn(`${label} 无法迁移，已替换为文字占位`);
  return {
    block_id: id,
    block_type: 2,
    __leaf: true,
    text: {
      elements: [{ text_run: { content: `[未迁移的内容: ${label}]`, text_element_style: { italic: true } } }],
    },
  };
}

function cleanStyle(style) {
  if (!style) return undefined;
  const { align, done, folded, language, wrap, background_color, indentation_level, sequence } = style;
  return Object.fromEntries(
    Object.entries({ align, done, folded, language, wrap, background_color, indentation_level, sequence }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

function cleanElementStyle(style) {
  if (!style) return undefined;
  const { comment_ids: _dropped, ...rest } = style;
  return rest;
}

function convertElement(element, ctx) {
  const textRun = (content, style) => ({
    text_run: { content, text_element_style: cleanElementStyle(style) },
  });

  if (element.text_run) {
    const style = cleanElementStyle(element.text_run.text_element_style) ?? {};
    if (style.link) {
      const url = targetLink(style.link.url ?? '', ctx);
      if (url) style.link = { url };
      else delete style.link;
    }
    return [{ text_run: { content: element.text_run.content, text_element_style: style } }];
  }
  if (element.equation) return [{ equation: { content: element.equation.content } }];
  if (element.mention_doc) {
    const { url, title, text_element_style: style } = element.mention_doc;
    const target = targetLink(url || '', ctx);
    return [textRun(title || safeDecode(url || '') || '文档链接', target ? { ...style, link: { url: target } } : style)];
  }
  if (element.mention_user) {
    ctx.warn('@提及的用户在新组织中 ID 不同，已转为纯文本');
    return [textRun('@用户', element.mention_user.text_element_style)];
  }
  if (element.reminder) {
    ctx.warn('日期提醒已转为纯文本');
    const when = new Date(Number(element.reminder.expire_time)).toLocaleString('zh-CN');
    return [textRun(`[提醒: ${when}]`, element.reminder.text_element_style)];
  }
  ctx.warn('部分行内元素（如行内文件）无法迁移，已跳过');
  return [];
}

// Lark only accepts absolute web links (code 1770006), so anything else loses its link and keeps its text.
function targetLink(encodedUrl, ctx) {
  const decoded = safeDecode(encodedUrl);
  const url = ctx.linkFor(decoded) ?? decoded;
  try {
    if (['http:', 'https:'].includes(new URL(url).protocol)) return encodeURIComponent(url);
  } catch {
    // Not a URL; handled below.
  }
  if (url) ctx.warn(`链接「${url.slice(0, 80)}」不是完整网址，已去掉链接，保留文字`);
  return null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function applyUpload({ client, documentId, relations, upload, assets, warn }) {
  const blockId = relations.get(upload.id);
  if (!blockId) return;
  const asset = assets.get(upload.assetKey);
  if (!asset) {
    warn('有图片或附件未能在本地找到，对应块留空');
    return;
  }
  const token = await client.upload({
    buffer: readFileSync(asset.path),
    fileName: asset.file_name || `${upload.kind}-${upload.id}`,
    parentType: upload.kind === 'image' ? 'docx_image' : 'docx_file',
    parentNode: blockId,
    extra: JSON.stringify({ drive_route_token: documentId }),
  });
  const body =
    upload.kind === 'image'
      ? { replace_image: { token, width: upload.width, height: upload.height } }
      : { replace_file: { token } };
  await client.patch(`/docx/v1/documents/${documentId}/blocks/${blockId}`, body, { document_revision_id: -1 });
}

async function applyMerge({ client, documentId, relations, merge, warn }) {
  const blockId = relations.get(merge.id);
  if (!blockId) return;
  for (let i = 0; i < merge.merge_info.length; i++) {
    const { row_span: rowSpan = 1, col_span: colSpan = 1 } = merge.merge_info[i];
    if (rowSpan <= 1 && colSpan <= 1) continue;
    const row = Math.floor(i / merge.column_size);
    const column = i % merge.column_size;
    try {
      await client.patch(
        `/docx/v1/documents/${documentId}/blocks/${blockId}`,
        {
          merge_table_cells: {
            row_start_index: row,
            row_end_index: row + rowSpan,
            column_start_index: column,
            column_end_index: column + colSpan,
          },
        },
        { document_revision_id: -1 },
      );
    } catch (err) {
      warn(`表格合并单元格失败: ${err.message}`);
    }
  }
}

async function fillEmbeddedSheet({ client, documentId, relations, sheet, warn }) {
  const blockId = relations.get(sheet.id);
  if (!blockId || !sheet.values.length) return;
  try {
    const { block } = await client.get(`/docx/v1/documents/${documentId}/blocks/${blockId}`);
    const token = block.sheet.token;
    const separator = token.lastIndexOf('_');
    const rows = sheet.values.slice(0, 100).map((row) => row.slice(0, 100).map(plainCell));
    const columns = Math.max(...rows.map((row) => row.length), 1);
    await client.request('PUT', `/sheets/v2/spreadsheets/${token.slice(0, separator)}/values`, {
      body: {
        valueRange: {
          range: `${token.slice(separator + 1)}!A1:${columnName(columns)}${rows.length}`,
          values: rows,
        },
      },
    });
    if (sheet.values.length > 100 || sheet.values.some((row) => row.length > 100)) {
      warn('内嵌电子表格超过 100 行或 100 列，只迁移了前 100 行、前 100 列');
    }
  } catch (err) {
    warn(`内嵌电子表格写入失败: ${err.message}`);
  }
}

// Rich cells (mentions, links) come back as segment arrays, which the values API will not accept.
function plainCell(cell) {
  if (!Array.isArray(cell)) return cell;
  return cell.map((segment) => segment?.text ?? '').join('');
}

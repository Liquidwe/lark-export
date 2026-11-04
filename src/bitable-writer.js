// Recreates a bitable app's tables, fields, views and records in a target app.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TEXT = 1;
const NUMBER = 2;
const DATE = 5;
const PERSON = 11;
const ATTACHMENT = 17;
const LINK = 18;
const LOOKUP = 19;
const FORMULA = 20;
const DUPLEX = 21;
const LOCATION = 22;
const GROUP = 23;
const CREATED_TIME = 1001;
const MODIFIED_TIME = 1002;
const CREATOR = 1003;
const MODIFIER = 1004;
const AUTO_NUMBER = 1005;
const BUTTON = 3001;

const RECORD_BATCH = 500;
const STATIC_LABELS = {
  [PERSON]: '人员', [GROUP]: '群组', [CREATOR]: '创建人', [MODIFIER]: '修改人',
  [FORMULA]: '公式', [LOOKUP]: '查找引用', [AUTO_NUMBER]: '自动编号',
};

export async function writeBitable({ client, appToken, content, assets, warn }) {
  const existing = await client.all(`/bitable/v1/apps/${appToken}/tables`, { page_size: 100 });
  const tableMap = new Map();
  const recordMap = new Map();

  // Tables must all exist before link fields can reference them, so links are added afterwards.
  for (const table of content.tables) {
    const fields = table.fields.filter((f) => !isLink(f) && f.type !== BUTTON);
    const primaryFirst = [...fields].sort((a, b) => Number(!!b.is_primary) - Number(!!a.is_primary));
    const { table_id: tableId } = await client.post(`/bitable/v1/apps/${appToken}/tables`, {
      table: {
        name: table.name,
        default_view_name: table.views[0]?.view_name,
        fields: primaryFirst.map((field) => targetField(field, warn)),
      },
    });
    tableMap.set(table.table_id, tableId);

    for (const view of table.views.slice(1)) {
      await createView(client, appToken, tableId, view, warn);
    }

    const ids = await writeRecords({ client, appToken, tableId, table, assets, warn });
    for (const [source, target] of ids) recordMap.set(source, target);
  }

  // A new app ships with a default table; it can only be removed once ours exist.
  for (const table of content.tables.length ? existing : []) {
    await client.delete(`/bitable/v1/apps/${appToken}/tables/${table.table_id}`);
  }

  const createdDuplex = new Set();
  for (const table of content.tables) {
    await writeLinks({ client, appToken, table, tableMap, recordMap, createdDuplex, warn });
  }
  if (content.tables.some((t) => t.views.length)) {
    warn('视图只迁移了名称和类型，筛选、排序、分组条件需要重新设置');
  }
}

const isLink = (field) => field.type === LINK || field.type === DUPLEX;

function targetField(field, warn) {
  const { field_name, type, property, ui_type, description } = field;
  if (STATIC_LABELS[type]) {
    warn(`字段「${field_name}」(${STATIC_LABELS[type]}) 已转为文本，保留当前显示的值`);
    return { field_name, type: TEXT, description: cleanDescription(description) };
  }
  if (type === CREATED_TIME || type === MODIFIED_TIME) {
    warn(`字段「${field_name}」已转为日期字段，保留原有时间`);
    return { field_name, type: DATE, property: { date_formatter: property?.date_formatter } };
  }
  return { field_name, type, ui_type, property: cleanProperty(property), description: cleanDescription(description) };
}

function cleanDescription(description) {
  return description?.text ? description : undefined;
}

function cleanProperty(property) {
  if (!property) return undefined;
  const clean = { ...property };
  if (clean.options) clean.options = clean.options.map(({ name, color }) => ({ name, color }));
  return clean;
}

async function createView(client, appToken, tableId, view, warn) {
  try {
    await client.post(`/bitable/v1/apps/${appToken}/tables/${tableId}/views`, {
      view_name: view.view_name,
      view_type: view.view_type,
    });
  } catch (err) {
    warn(`视图「${view.view_name}」创建失败: ${err.message}`);
  }
}

async function writeRecords({ client, appToken, tableId, table, assets, warn }) {
  const fields = table.fields.filter((f) => !isLink(f) && f.type !== BUTTON);
  const mapping = new Map();
  const uploaded = new Map();
  const base = `/bitable/v1/apps/${appToken}/tables/${tableId}`;

  const rows = [];
  for (const record of table.records) {
    const values = {};
    for (const field of fields) {
      const raw = record.fields[field.field_name];
      if (raw === undefined || raw === null) continue;
      const value = await convertValue({ client, appToken, field, raw, assets, uploaded, warn });
      if (value !== undefined) values[field.field_name] = value;
    }
    rows.push({ source: record.record_id, fields: values });
  }

  for (let i = 0; i < rows.length; i += RECORD_BATCH) {
    const batch = rows.slice(i, i + RECORD_BATCH);
    const { records } = await client.post(
      `${base}/records/batch_create`,
      { records: batch.map(({ fields: values }) => ({ fields: values })) },
      { client_token: randomUUID() },
    );
    records.forEach((created, index) => mapping.set(batch[index].source, created.record_id));
  }
  return mapping;
}

async function convertValue({ client, appToken, field, raw, assets, uploaded, warn }) {
  switch (field.type) {
    case PERSON:
    case GROUP:
    case CREATOR:
    case MODIFIER:
    case FORMULA:
    case LOOKUP:
    case AUTO_NUMBER:
      return plainText(raw);
    case TEXT:
      return plainText(raw);
    case NUMBER:
      return typeof raw === 'number' ? raw : Number(raw);
    case LOCATION:
      return raw.location ?? undefined;
    case ATTACHMENT: {
      const items = [];
      for (const item of raw) {
        if (!uploaded.has(item.file_token)) {
          const asset = assets.get(`attachment:${item.file_token}`);
          if (!asset) {
            warn(`附件「${item.name}」未在本地找到，已跳过`);
            continue;
          }
          uploaded.set(
            item.file_token,
            await client.upload({
              buffer: readFileSync(asset.path),
              fileName: asset.file_name || item.name,
              parentType: 'bitable_file',
              parentNode: appToken,
            }),
          );
        }
        items.push({ file_token: uploaded.get(item.file_token) });
      }
      return items;
    }
    default:
      return raw;
  }
}

function plainText(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw !== 'object') return String(raw);
  if (Array.isArray(raw)) return raw.map(plainText).join('');
  if (raw.value !== undefined) return plainText(raw.value);
  return raw.text ?? raw.name ?? raw.en_name ?? raw.link ?? JSON.stringify(raw);
}

async function writeLinks({ client, appToken, table, tableMap, recordMap, createdDuplex, warn }) {
  const links = table.fields.filter(isLink);
  const tableId = tableMap.get(table.table_id);
  const base = `/bitable/v1/apps/${appToken}/tables/${tableId}`;
  const writable = [];

  for (const field of links) {
    const target = tableMap.get(field.property?.table_id);
    if (!target) {
      warn(`关联字段「${field.field_name}」指向其他多维表格，已跳过`);
      continue;
    }
    if (field.type === DUPLEX) {
      // Creating one side creates its partner, and writing one side syncs the other.
      if (createdDuplex.has(field.field_id)) continue;
      createdDuplex.add(field.property?.back_field_id);
    }
    await client.post(`${base}/fields`, {
      field_name: field.field_name,
      type: field.type,
      property: {
        table_id: target,
        multiple: field.property?.multiple ?? true,
        ...(field.type === DUPLEX ? { back_field_name: field.property?.back_field_name } : {}),
      },
    });
    writable.push(field);
  }
  if (!writable.length) return;

  const updates = [];
  for (const record of table.records) {
    const fields = {};
    for (const field of writable) {
      const ids = linkedIds(record.fields[field.field_name])
        .map((id) => recordMap.get(id))
        .filter(Boolean);
      if (ids.length) fields[field.field_name] = ids;
    }
    if (Object.keys(fields).length) updates.push({ record_id: recordMap.get(record.record_id), fields });
  }
  for (let i = 0; i < updates.length; i += RECORD_BATCH) {
    await client.post(`${base}/records/batch_update`, { records: updates.slice(i, i + RECORD_BATCH) });
  }
}

function linkedIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(linkedIds);
  return value.link_record_ids ?? value.record_ids ?? [];
}

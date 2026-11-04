import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = resolve(PROJECT_DIR, process.env.DATA_DIR || 'data');
export const BLOB_DIR = join(DATA_DIR, 'blobs');
mkdirSync(BLOB_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'lark-export.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT NOT NULL,
    host TEXT NOT NULL,
    api_base TEXT NOT NULL,
    root_token TEXT NOT NULL,
    root_title TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    tree_complete INTEGER NOT NULL DEFAULT 0,
    phase TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    export_id INTEGER NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
    node_token TEXT NOT NULL,
    parent_token TEXT,
    obj_token TEXT,
    obj_type TEXT NOT NULL,
    node_type TEXT,
    origin_node_token TEXT,
    title TEXT,
    depth INTEGER NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    content TEXT,
    stats TEXT,
    warnings TEXT,
    UNIQUE (export_id, node_token)
  );

  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    export_id INTEGER NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    token TEXT NOT NULL,
    file_name TEXT,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    UNIQUE (node_id, kind, token)
  );

  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    export_id INTEGER NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
    target_url TEXT NOT NULL,
    target_host TEXT NOT NULL,
    api_base TEXT NOT NULL,
    target_token TEXT NOT NULL,
    space_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    phase TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS migration_items (
    migration_id INTEGER NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_node_token TEXT,
    target_obj_token TEXT,
    target_obj_type TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    warnings TEXT,
    PRIMARY KEY (migration_id, node_id)
  );

  CREATE INDEX IF NOT EXISTS idx_nodes_export ON nodes(export_id, position);
`);

// A restart kills in-process jobs, so anything still "running" can never finish on its own.
db.exec(`
  UPDATE exports SET status = 'interrupted' WHERE status IN ('running', 'pausing');
  UPDATE migrations SET status = 'interrupted' WHERE status IN ('running', 'pausing');
  UPDATE nodes SET status = 'pending' WHERE status = 'reading';
`);

export const parseJson = (value, fallback = null) => (value ? JSON.parse(value) : fallback);

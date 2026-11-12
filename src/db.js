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

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    open_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT NOT NULL,
    target_url TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    docs TEXT NOT NULL,
    progress TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS lark_accounts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    side TEXT NOT NULL,
    open_id TEXT NOT NULL,
    name TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    access_expires_at INTEGER,
    refresh_expires_at INTEGER,
    PRIMARY KEY (user_id, side)
  );
`);

// Volumes outlive the image, so columns added later have to be added to existing databases too.
function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('migrations', 'active_ms', 'INTEGER NOT NULL DEFAULT 0');
addColumn('migration_items', 'duration_ms', 'INTEGER NOT NULL DEFAULT 0');
// NULL means the admin, which also covers records from before there were members.
addColumn('exports', 'owner_id', 'INTEGER REFERENCES users(id)');
// Where a node lives: a wiki space, or a member's Drive folders.
addColumn('nodes', 'space', "TEXT NOT NULL DEFAULT 'wiki'");

// A restart kills in-process jobs, so anything still "running" can never finish on its own.
db.exec(`
  UPDATE exports SET status = 'interrupted' WHERE status IN ('running', 'pausing');
  UPDATE migrations SET status = 'interrupted' WHERE status IN ('running', 'pausing');
  UPDATE repairs SET status = 'interrupted' WHERE status IN ('scanning', 'applying');
  UPDATE nodes SET status = 'pending' WHERE status = 'reading';
`);

export const parseJson = (value, fallback = null) => (value ? JSON.parse(value) : fallback);

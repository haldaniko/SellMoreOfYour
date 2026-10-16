import Database from 'better-sqlite3';

export const SQLITE_APPLICATION_ID = 0x534d4f59; // SMOY
export const SQLITE_SCHEMA_VERSION = 1;
export const sqliteNow = "(strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z')";
const uuid = "(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))))";

export const applicationTables = [
  'users', 'refresh_tokens', 'generated_posts', 'admin_settings', 'audit_events', 'subscribers',
] as const;
const requiredColumns: Record<typeof applicationTables[number], string[]> = {
  users: ['id', 'email', 'password_hash', 'role', 'created_at'],
  refresh_tokens: ['id', 'user_id', 'token_hash', 'csrf_token', 'expires_at', 'created_at'],
  generated_posts: ['id', 'slug', 'title', 'excerpt', 'content_html', 'status', 'author', 'tags', 'seo_title', 'seo_description', 'source', 'created_at', 'updated_at'],
  admin_settings: ['key', 'value', 'updated_at'],
  audit_events: ['id', 'actor_id', 'actor_email', 'event_type', 'metadata', 'created_at'],
  subscribers: ['id', 'email', 'created_at'],
};

export function configureSqlite(db: Database.Database) {
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
}

export function createSqliteSchema(db: Database.Database) {
  configureSqlite(db);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY DEFAULT ${uuid},
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT ${sqliteNow}
    );
    CREATE TABLE refresh_tokens (
      id TEXT PRIMARY KEY DEFAULT ${uuid},
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${sqliteNow}
    );
    CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens(user_id);
    CREATE TABLE generated_posts (
      id TEXT PRIMARY KEY DEFAULT ${uuid},
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      content_html TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      author TEXT NOT NULL DEFAULT 'Editorial team',
      tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
      seo_title TEXT,
      seo_description TEXT,
      source TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT ${sqliteNow},
      updated_at TEXT NOT NULL DEFAULT ${sqliteNow}
    );
    CREATE TABLE admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL CHECK (json_valid(value)),
      updated_at TEXT NOT NULL DEFAULT ${sqliteNow}
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY DEFAULT ${uuid},
      actor_id TEXT,
      actor_email TEXT,
      event_type TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
      created_at TEXT NOT NULL DEFAULT ${sqliteNow}
    );
    CREATE TABLE subscribers (
      id TEXT PRIMARY KEY DEFAULT ${uuid},
      email TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT ${sqliteNow}
    );
  `);
  db.pragma(`application_id = ${SQLITE_APPLICATION_ID}`);
  db.pragma(`user_version = ${SQLITE_SCHEMA_VERSION}`);
}

export function verifySqlite(db: Database.Database) {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
  db.pragma('synchronous = FULL');
  if (db.pragma('journal_mode', { simple: true }) !== 'delete') throw new Error('SQLite journal mode must be DELETE');
  if (db.pragma('application_id', { simple: true }) !== SQLITE_APPLICATION_ID ||
      db.pragma('user_version', { simple: true }) !== SQLITE_SCHEMA_VERSION) {
    throw new Error('Existing db.sqlite3 is not a recognized SellMoreOfYour database');
  }
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
  for (const table of applicationTables) {
    if (!tables.has(table)) throw new Error(`SQLite table ${table} is missing`);
    const columns = db.pragma(`table_info(${table})`) as { name: string; pk: number }[];
    const names = new Set(columns.map(column => column.name));
    for (const column of requiredColumns[table]) {
      if (!names.has(column)) throw new Error(`SQLite column ${table}.${column} is missing`);
    }
    const key = table === 'admin_settings' ? 'key' : 'id';
    if (!columns.some(column => column.name === key && column.pk === 1)) throw new Error(`SQLite primary key ${table}.${key} is missing`);
  }
  for (const [table, column] of [['users', 'email'], ['refresh_tokens', 'token_hash'], ['generated_posts', 'slug'], ['subscribers', 'email']]) {
    const indexes = db.pragma(`index_list(${table})`) as { name: string; unique: number }[];
    const found = indexes.some(index => index.unique === 1 &&
      (db.pragma(`index_info('${index.name.replace(/'/g, "''")}')`) as { name: string }[]).map(item => item.name).join(',') === column);
    if (!found) throw new Error(`SQLite unique index ${table}.${column} is missing`);
  }
  const foreignKeys = db.pragma('foreign_key_list(refresh_tokens)') as { table: string; from: string; to: string; on_delete: string }[];
  if (!foreignKeys.some(key => key.table === 'users' && key.from === 'user_id' && key.to === 'id' && key.on_delete === 'CASCADE')) {
    throw new Error('SQLite refresh_tokens user relation is missing');
  }
  const userIndex = db.pragma('index_list(refresh_tokens)') as { name: string }[];
  if (!userIndex.some(index => index.name === 'refresh_tokens_user_id_idx')) throw new Error('SQLite refresh token user index is missing');
  if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('SQLite integrity_check failed');
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('SQLite foreign_key_check failed');
}

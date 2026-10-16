import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Client } from 'pg';
import Database from 'better-sqlite3';
import { applicationTables, createSqliteSchema, verifySqlite } from './services/sqliteSchema';

type TableSpec = { name: typeof applicationTables[number]; columns: string[]; timestamps: string[]; key: string };
const specs: TableSpec[] = [
  { name: 'users', columns: ['id', 'email', 'password_hash', 'role', 'created_at'], timestamps: ['created_at'], key: 'id' },
  { name: 'refresh_tokens', columns: ['id', 'user_id', 'token_hash', 'csrf_token', 'expires_at', 'created_at'], timestamps: ['expires_at', 'created_at'], key: 'id' },
  { name: 'generated_posts', columns: ['id', 'slug', 'title', 'excerpt', 'content_html', 'status', 'author', 'tags', 'seo_title', 'seo_description', 'source', 'created_at', 'updated_at'], timestamps: ['created_at', 'updated_at'], key: 'id' },
  { name: 'admin_settings', columns: ['key', 'value', 'updated_at'], timestamps: ['updated_at'], key: 'key' },
  { name: 'audit_events', columns: ['id', 'actor_id', 'actor_email', 'event_type', 'metadata', 'created_at'], timestamps: ['created_at'], key: 'id' },
  { name: 'subscribers', columns: ['id', 'email', 'created_at'], timestamps: ['created_at'], key: 'id' },
];

function normalizedRow(row: Record<string, unknown>, spec: TableSpec) {
  return Object.fromEntries(spec.columns.map(column => {
    const value = row[column];
    return [column, column === 'tags' ? JSON.stringify(value) : value];
  }));
}

function validateExisting(file: string) {
  const db = new Database(file, { fileMustExist: true, readonly: true });
  try { verifySqlite(db); } finally { db.close(); }
}

async function main() {
  const target = process.env.SQLITE_PATH || '/data/db.sqlite3';
  if (fs.existsSync(target)) {
    validateExisting(target);
    console.log(`${target} is valid; retaining existing SQLite data`);
    return;
  }
  const connectionString = process.env.SOURCE_DATABASE_URL;
  if (!connectionString) throw new Error('SOURCE_DATABASE_URL is required for initial migration');
  const directory = path.dirname(target);
  const lock = `${target}.migration.lock`;
  const temporary = `${target}.migrating-${process.pid}`;
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  let client: Client | undefined;
  let db: Database.Database | undefined;
  try {
    for (let attempt = 1; attempt <= 60; attempt++) {
      const candidate = new Client({ connectionString, connectionTimeoutMillis: 3000 });
      try {
        await candidate.connect();
        client = candidate;
        break;
      } catch (error) {
        await candidate.end().catch(() => undefined);
        if (attempt === 60) throw error;
        if (attempt === 1 || attempt % 10 === 0) console.log(`Waiting for PostgreSQL (${attempt}/60)`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    if (!client) throw new Error('PostgreSQL connection was not established');
    // A previous failed attempt may already have made this database read-only.
    await client.query('SET default_transaction_read_only = off');
    // Fail before changing PostgreSQL if the deployed schema does not match the app.
    for (const spec of specs) {
      const result = await client.query<{ column_name: string }>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        ['public', spec.name],
      );
      const available = new Set(result.rows.map(row => row.column_name));
      for (const column of spec.columns) if (!available.has(column)) throw new Error(`PostgreSQL ${spec.name}.${column} is missing`);
    }
    // New sessions become read-only; kill existing app sessions before taking the snapshot.
    // This prevents writes to the old database during and after the cutover.
    const dbName = (await client.query<{ current_database: string }>('SELECT current_database()')).rows[0].current_database;
    await client.query(`ALTER DATABASE "${dbName.replace(/"/g, '""')}" SET default_transaction_read_only = on`);
    await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND usename = current_user`);
    const others = await client.query<{ count: string }>(`SELECT count(*) FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`);
    if (Number(others.rows[0].count) !== 0) throw new Error('Other PostgreSQL clients remain connected; migration stopped');

    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    db = new Database(temporary);
    createSqliteSchema(db);
    db.exec('BEGIN');
    for (const spec of specs) {
      const select = spec.columns.map(column => spec.timestamps.includes(column)
        ? `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`
        : column === 'value' || column === 'metadata' ? `${column}::text AS ${column}` : column).join(', ');
      const sourceOrder = spec.name === 'admin_settings' ? `${spec.key} COLLATE "C"` : spec.key;
      await client.query(`DECLARE migration_cursor NO SCROLL CURSOR FOR SELECT ${select} FROM public.${spec.name} ORDER BY ${sourceOrder}`);
      const placeholders = spec.columns.map(() => '?').join(', ');
      const insert = db.prepare(`INSERT INTO ${spec.name} (${spec.columns.join(', ')}) VALUES (${placeholders})`);
      const sourceHash = crypto.createHash('sha256');
      let count = 0;
      for (;;) {
        const batch = await client.query<Record<string, unknown>>('FETCH FORWARD 500 FROM migration_cursor');
        if (!batch.rows.length) break;
        for (const row of batch.rows) {
          const normalized = normalizedRow(row, spec);
          insert.run(...spec.columns.map(column => normalized[column]));
          sourceHash.update(JSON.stringify(normalized) + '\n');
          count++;
        }
      }
      await client.query('CLOSE migration_cursor');
      const sourceCount = await client.query<{ count: string }>(`SELECT count(*) FROM public.${spec.name}`);
      if (count !== Number(sourceCount.rows[0].count)) throw new Error(`${spec.name}: source count changed`);
      const destinationHash = crypto.createHash('sha256');
      let destinationCount = 0;
      for (const row of db.prepare(`SELECT ${spec.columns.join(', ')} FROM ${spec.name} ORDER BY ${spec.key}`).iterate() as Iterable<Record<string, unknown>>) {
        destinationHash.update(JSON.stringify(row) + '\n');
        destinationCount++;
      }
      if (destinationCount !== count || destinationHash.digest('hex') !== sourceHash.digest('hex')) {
        throw new Error(`${spec.name}: row count or content mismatch`);
      }
      console.log(`${spec.name}: ${count} rows verified`);
    }
    db.exec('COMMIT');
    verifySqlite(db);
    db.close();
    db = undefined;
    validateExisting(temporary);
    if (fs.existsSync(target)) throw new Error(`${target} appeared during migration; refusing to overwrite it`);
    const owner = fs.statSync(directory);
    fs.chownSync(temporary, owner.uid, owner.gid);
    fs.chmodSync(temporary, 0o600);
    const fileFd = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(fileFd); } finally { fs.closeSync(fileFd); }
    fs.renameSync(temporary, target);
    const dirFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    await client.query('COMMIT');
    console.log(`Migration completed: ${target}`);
  } catch (error) {
    if (db) { try { db.close(); } catch { /* preserve original error */ } }
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  } finally {
    if (client) await client.end();
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

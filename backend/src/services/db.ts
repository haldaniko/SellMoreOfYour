import { Pool, type QueryResultRow } from 'pg';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { samplePosts } from '../data/samplePosts';
import { sanitizeArticleHtml } from './htmlSanitizer';
import { verifySqlite } from './sqliteSchema';

const fallbackDatabaseUrl = 'postgres://sellmoreofyour:sellmoreofyour@localhost:5432/sellmoreofyour';

function requireProductionEnv() {
  if (process.env.NODE_ENV !== 'production') return;
  const required = ['DATABASE_URL', 'JWT_SECRET', 'REFRESH_TOKEN_SECRET'] as const;
  for (const key of required) {
    if (!process.env[key]) throw new Error(`${key} is required in production`);
  }
  if (process.env.JWT_SECRET === process.env.REFRESH_TOKEN_SECRET) {
    throw new Error('JWT_SECRET and REFRESH_TOKEN_SECRET must be different');
  }
  if ((process.env.JWT_SECRET || '').length < 32 || (process.env.REFRESH_TOKEN_SECRET || '').length < 32) {
    throw new Error('JWT secrets must be at least 32 characters');
  }
  const origin = process.env.CORS_ORIGIN || '';
  const siteUrl = process.env.SITE_URL || '';
  if (origin.includes('localhost') || siteUrl.includes('localhost')) {
    throw new Error('Production CORS_ORIGIN and SITE_URL must not point to localhost');
  }
}

requireProductionEnv();

const databaseUrl = process.env.DATABASE_URL || fallbackDatabaseUrl;
export const isSqlite = databaseUrl.startsWith('sqlite:');
const sqlitePath = isSqlite ? databaseUrl.slice('sqlite:'.length) : '';
let sqlite: Database.Database | undefined;
export const pool = isSqlite ? undefined : new Pool({ connectionString: databaseUrl });

function sqliteDb() {
  if (!sqlite) {
    if (!sqlitePath) throw new Error('SQLite path is empty');
    const candidate = new Database(sqlitePath, { fileMustExist: true });
    try {
      verifySqlite(candidate);
      // Exercise a real journal write before reporting the backend healthy.
      candidate.exec('BEGIN IMMEDIATE');
      candidate.prepare('INSERT INTO subscribers (email) VALUES (?)').run(`probe-${randomUUID()}@invalid.example`);
      candidate.exec('ROLLBACK');
      sqlite = candidate;
    } catch (error) {
      if (candidate.inTransaction) candidate.exec('ROLLBACK');
      candidate.close();
      throw error;
    }
  }
  return sqlite;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
  if (!isSqlite) return pool!.query<T>(text, params);
  const values: unknown[] = [];
  const sql = text.replace(/\$(\d+)/g, (_match, index: string) => {
    const value = params[Number(index) - 1];
    values.push(Array.isArray(value) ? JSON.stringify(value) : value);
    return '?';
  });
  const statement = sqliteDb().prepare(sql);
  const rows = statement.reader ? statement.all(...values) : (statement.run(...values), []);
  return { rows: rows as T[], rowCount: rows.length };
}

export async function ensureSchema() {
  if (isSqlite) {
    sqliteDb(); // Fail closed: production must never create an empty replacement DB.
    return;
  }
  await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      role text NOT NULL DEFAULT 'admin',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text UNIQUE NOT NULL,
      csrf_token text NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS generated_posts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text UNIQUE NOT NULL,
      title text NOT NULL,
      excerpt text NOT NULL,
      content_html text NOT NULL,
      status text NOT NULL DEFAULT 'published',
      author text NOT NULL DEFAULT 'Editorial team',
      tags text[] NOT NULL DEFAULT '{}',
      seo_title text,
      seo_description text,
      source text NOT NULL DEFAULT 'admin',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS admin_settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id uuid,
      actor_email text,
      event_type text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS subscribers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const count = await query<{ count: string }>('SELECT count(*) FROM generated_posts');
  if (Number(count.rows[0]?.count || 0) === 0) {
    for (const post of samplePosts) {
      await query(
        `INSERT INTO generated_posts (slug, title, excerpt, content_html, tags, seo_title, seo_description, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'legacy')
         ON CONFLICT (slug) DO NOTHING`,
        [
          post.slug,
          post.title,
          post.excerpt,
          sanitizeArticleHtml(post.contentHtml),
          post.tags || [],
          post.seoTitle || null,
          post.seoDescription || null,
        ],
      );
    }
  }
}

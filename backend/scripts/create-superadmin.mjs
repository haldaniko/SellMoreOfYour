import { Pool } from 'pg';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const email = process.env.LOCAL_SUPERADMIN_EMAIL || process.env.SUPERADMIN_EMAIL || 'admin@sellmoreofyour.local';
const password = process.env.LOCAL_SUPERADMIN_PASSWORD || process.env.SUPERADMIN_PASSWORD || 'MySecretPassword123!';
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error('DATABASE_URL is required');

if (databaseUrl.startsWith('sqlite:')) {
  const db = new Database(databaseUrl.slice('sqlite:'.length), { fileMustExist: true });
  try {
    const existing = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email);
    if (existing) {
      console.log(`Superadmin already exists: ${email}; password retained`);
    } else {
      const passwordHash = await bcrypt.hash(password, 12);
      db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')").run(email, passwordHash);
      console.log(`Superadmin created: ${email}`);
    }
  } finally { db.close(); }
} else {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      role text NOT NULL DEFAULT 'admin',
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin') ON CONFLICT (email) DO NOTHING",
      [email, passwordHash],
    );
    console.log(result.rowCount ? `Superadmin created: ${email}` : `Superadmin already exists: ${email}; password retained`);
  } finally { await pool.end(); }
}

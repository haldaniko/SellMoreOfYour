import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { isSqlite, query } from './db';
import { findUserByEmail, findUserById } from './userStore';
import type { AuthedRequestUser, User } from '../types';

const accessTtl = '15m';
const refreshDays = 30;

function jwtSecret() {
  return process.env.JWT_SECRET || 'dev-jwt-secret-change-me-please-32chars';
}

function refreshSecret() {
  return process.env.REFRESH_TOKEN_SECRET || 'dev-refresh-secret-change-me-please-32';
}

export function hashToken(token: string) {
  return crypto.createHmac('sha256', refreshSecret()).update(token).digest('hex');
}

export function signAccessToken(user: User | AuthedRequestUser) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, jwtSecret(), { expiresIn: accessTtl });
}

export function verifyAccessToken(token: string): AuthedRequestUser {
  const payload = jwt.verify(token, jwtSecret()) as jwt.JwtPayload;
  return { id: String(payload.sub), email: String(payload.email), role: 'admin' };
}

export async function login(email: string, password: string) {
  const user = await findUserByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return null;
  const accessToken = signAccessToken(user);
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  if (isSqlite) {
    const expiresAt = new Date(Date.now() + refreshDays * 86400000).toISOString().replace('Z', '000Z');
    await query(
      'INSERT INTO refresh_tokens (user_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4)',
      [user.id, hashToken(refreshToken), csrfToken, expiresAt],
    );
  } else {
    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, csrf_token, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
      [user.id, hashToken(refreshToken), csrfToken, refreshDays],
    );
  }
  return { user: { id: user.id, email: user.email, role: user.role }, accessToken, refreshToken, csrfToken };
}

export async function refreshSession(refreshToken: string, csrfToken: string | undefined) {
  if (!refreshToken || !csrfToken) return null;
  const result = await query<{ user_id: string; csrf_token: string }>(
    `SELECT rt.*, u.email, u.role
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.expires_at > ${isSqlite ? "(strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z')" : 'now()'}`,
    [hashToken(refreshToken)],
  );
  const row = result.rows[0];
  if (!row || row.csrf_token !== csrfToken) return null;
  const user = await findUserById(row.user_id);
  if (!user) return null;
  return { accessToken: signAccessToken(user), user: { id: user.id, email: user.email, role: user.role } };
}

export async function logout(refreshToken: string) {
  if (!refreshToken) return;
  await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hashToken(refreshToken)]);
}

import slugify from 'slugify';
import { isSqlite, query } from './db';
import { sanitizeArticleHtml } from './htmlSanitizer';
import type { Post, PostInput } from '../types';

function mapPost(row: any): Post {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    contentHtml: row.content_html,
    status: row.status,
    author: row.author,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : (row.tags || []),
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function makeSlug(title: string) {
  return slugify(title, { lower: true, strict: true, trim: true }) || `post-${Date.now()}`;
}

export async function listPosts(includeDrafts = false): Promise<Post[]> {
  const result = await query(
    `SELECT * FROM generated_posts ${includeDrafts ? '' : "WHERE status = 'published'"} ORDER BY created_at DESC`,
  );
  return result.rows.map(mapPost);
}

export async function getPost(slug: string, includeDrafts = false): Promise<Post | null> {
  const result = await query(
    `SELECT * FROM generated_posts WHERE slug = $1 ${includeDrafts ? '' : "AND status = 'published'"} LIMIT 1`,
    [slug],
  );
  return result.rows[0] ? mapPost(result.rows[0]) : null;
}

export async function searchPosts(q: string): Promise<Post[]> {
  const term = `%${q.trim()}%`;
  const result = await query(
    `SELECT * FROM generated_posts
     WHERE status = 'published' AND (title ${isSqlite ? 'LIKE' : 'ILIKE'} $1 OR excerpt ${isSqlite ? 'LIKE' : 'ILIKE'} $1 OR content_html ${isSqlite ? 'LIKE' : 'ILIKE'} $1)
     ORDER BY created_at DESC LIMIT 30`,
    [term],
  );
  return result.rows.map(mapPost);
}

export async function upsertPost(input: PostInput, source: Post['source'] = 'admin', currentSlug?: string): Promise<Post> {
  const slug = input.slug ? makeSlug(input.slug) : makeSlug(input.title);
  const values = [
    slug,
    input.title.trim(),
    input.excerpt.trim(),
    sanitizeArticleHtml(input.contentHtml),
    input.status || 'published',
    input.author || 'Editorial team',
    input.tags || [],
    input.seoTitle || null,
    input.seoDescription || null,
    source,
  ];
  const result = await query(
    `INSERT INTO generated_posts (slug, title, excerpt, content_html, status, author, tags, seo_title, seo_description, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (slug) DO UPDATE SET
       title = excluded.title,
       excerpt = excluded.excerpt,
       content_html = excluded.content_html,
       status = excluded.status,
       author = excluded.author,
       tags = excluded.tags,
       seo_title = excluded.seo_title,
       seo_description = excluded.seo_description,
       source = excluded.source,
       updated_at = ${isSqlite ? "(strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z')" : 'now()'}
     RETURNING *`,
    values,
  );

  if (currentSlug && currentSlug !== slug) {
    await query('DELETE FROM generated_posts WHERE slug = $1', [currentSlug]);
  }

  return mapPost(result.rows[0]);
}

export async function deletePost(slug: string) {
  await query('DELETE FROM generated_posts WHERE slug = $1', [slug]);
}

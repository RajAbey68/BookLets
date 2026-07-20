import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getPostSlugs,
  getPostBySlug,
  getAllPosts,
  markdownToHtml,
} from '@/lib/blog';

/**
 * src/lib/blog.ts reads content/blog/*.md straight off disk. Every reader
 * takes an optional `dir` override, so these tests point it at a throwaway
 * fixture directory rather than mutating the real content/blog/ folder the
 * site serves.
 */

let blogDir: string;

beforeAll(() => {
  blogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-test-'));

  fs.writeFileSync(
    path.join(blogDir, 'README.md'),
    '# not a post — must be excluded from listings\n'
  );

  fs.writeFileSync(
    path.join(blogDir, '2026-01-01-first-post.md'),
    [
      '---',
      'title: "First Post"',
      'description: "The first one."',
      'date: "2026-01-01"',
      'tags: ["a", "b"]',
      'keywords: ["k1"]',
      'author: "BookLets Team"',
      'draft: false',
      '---',
      '',
      'word '.repeat(400).trim(),
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(blogDir, '2026-02-01-second-post.md'),
    [
      '---',
      'title: "Second Post"',
      'description: "The newer one."',
      'date: "2026-02-01"',
      '---',
      '',
      'Short body.',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(blogDir, '2026-03-01-unfinished-post.md'),
    [
      '---',
      'title: "Unfinished Post"',
      'description: "Not ready yet."',
      'date: "2026-03-01"',
      'draft: true',
      '---',
      '',
      'Draft body.',
    ].join('\n')
  );
});

afterAll(() => {
  fs.rmSync(blogDir, { recursive: true, force: true });
});

describe('blog content loading', () => {
  it('lists post slugs from filenames, excluding README', () => {
    const slugs = getPostSlugs(blogDir);
    expect(slugs).toContain('2026-01-01-first-post');
    expect(slugs).toContain('2026-02-01-second-post');
    expect(slugs).not.toContain('README');
  });

  it('returns an empty list for a directory that does not exist', () => {
    expect(getPostSlugs(path.join(blogDir, 'nope'))).toEqual([]);
  });

  it('parses frontmatter and fills defaults for optional fields', () => {
    const post = getPostBySlug('2026-02-01-second-post', blogDir);
    expect(post).not.toBeNull();
    expect(post?.title).toBe('Second Post');
    expect(post?.tags).toEqual([]);
    expect(post?.author).toBe('BookLets Team');
    expect(post?.draft).toBe(false);
  });

  it('returns null for a slug that does not exist', () => {
    expect(getPostBySlug('does-not-exist', blogDir)).toBeNull();
  });

  it('excludes drafts from getAllPosts by default and sorts newest first', () => {
    const posts = getAllPosts({ dir: blogDir });
    expect(posts.map((p) => p.slug)).toEqual([
      '2026-02-01-second-post',
      '2026-01-01-first-post',
    ]);
  });

  it('includes drafts when includeDrafts is true', () => {
    const posts = getAllPosts({ includeDrafts: true, dir: blogDir });
    expect(posts.map((p) => p.slug)).toContain('2026-03-01-unfinished-post');
  });

  it('estimates reading time from word count (~200wpm, minimum 1)', () => {
    const long = getPostBySlug('2026-01-01-first-post', blogDir);
    const short = getPostBySlug('2026-02-01-second-post', blogDir);
    expect(long?.readingTimeMinutes).toBe(2);
    expect(short?.readingTimeMinutes).toBe(1);
  });
});

describe('markdownToHtml', () => {
  it('renders GitHub-flavored markdown to HTML', async () => {
    const html = await markdownToHtml('# Title\n\n- one\n- two\n');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li>one</li>');
  });
});

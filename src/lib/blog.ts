import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";

export const BLOG_DIR = path.join(process.cwd(), "content/blog");

/**
 * Slugs come from filenames on disk, which CodeQL (correctly) treats as an
 * untrusted store. Constraining them to a kebab charset means a slug can
 * never carry a `javascript:`/`data:` payload or path segment into an href
 * or a route param — anything outside this shape is dropped, not rendered.
 */
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface BlogPostMeta {
  slug: string;
  title: string;
  description: string;
  date: string;
  tags: string[];
  keywords: string[];
  author: string;
  draft: boolean;
  readingTimeMinutes: number;
}

export interface BlogPost extends BlogPostMeta {
  content: string;
}

function wordsPerMinute(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/**
 * Filenames double as slugs (e.g. `2026-07-20-my-post.md` -> slug
 * `2026-07-20-my-post`), so listing and lookup can't disagree on identity.
 *
 * Every reader takes an optional `dir` override (default: the real
 * content/blog/) so unit tests can point at a throwaway fixture directory
 * instead of the content the site actually serves.
 */
export function getPostSlugs(dir: string = BLOG_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file.toLowerCase() !== "readme.md")
    .map((file) => file.replace(/\.md$/, ""))
    .filter((slug) => SAFE_SLUG.test(slug));
}

function readPostFile(
  slug: string,
  dir: string
): { data: Record<string, unknown>; content: string } | null {
  const filePath = path.join(dir, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  const { data, content } = matter(raw);
  return { data, content };
}

function toPostMeta(slug: string, data: Record<string, unknown>, content: string): BlogPostMeta {
  return {
    slug,
    title: typeof data.title === "string" ? data.title : slug,
    description: typeof data.description === "string" ? data.description : "",
    date: typeof data.date === "string" ? data.date : "1970-01-01",
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    keywords: Array.isArray(data.keywords) ? data.keywords.map(String) : [],
    author: typeof data.author === "string" ? data.author : "BookLets Team",
    draft: data.draft === true,
    readingTimeMinutes: wordsPerMinute(content),
  };
}

export function getPostBySlug(slug: string, dir: string = BLOG_DIR): BlogPost | null {
  // `slug` reaches this from the [slug] route param — reject anything that
  // isn't a plain kebab slug before it touches the filesystem, so it can
  // never traverse out of the blog directory.
  if (!SAFE_SLUG.test(slug)) return null;
  const file = readPostFile(slug, dir);
  if (!file) return null;
  return { ...toPostMeta(slug, file.data, file.content), content: file.content };
}

/**
 * Drafts are excluded by default — the blog-population skills write new
 * posts with `draft: true` so a human reviews content before it goes public.
 */
export function getAllPosts({
  includeDrafts = false,
  dir = BLOG_DIR,
}: { includeDrafts?: boolean; dir?: string } = {}): BlogPostMeta[] {
  const posts = getPostSlugs(dir)
    .map((slug) => {
      const file = readPostFile(slug, dir);
      return file ? toPostMeta(slug, file.data, file.content) : null;
    })
    .filter((post): post is BlogPostMeta => post !== null)
    .filter((post) => includeDrafts || !post.draft);

  return posts.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Renders post Markdown to HTML for `dangerouslySetInnerHTML`. rehype-sanitize
 * (GitHub's default schema) runs in the pipeline, so even a malicious or
 * mistaken `.md` file can't inject `<script>`, event handlers, or
 * `javascript:` URLs into a rendered page — the draft-review gate is the
 * first line of defense, this is the second.
 */
export async function markdownToHtml(markdown: string): Promise<string> {
  const result = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSanitize)
    .use(rehypeStringify)
    .process(markdown);
  return result.toString();
}

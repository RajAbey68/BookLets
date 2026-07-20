import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAllPosts, getPostBySlug, markdownToHtml } from "@/lib/blog";

export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post || post.draft) return {};

  return {
    title: `${post.title} — BookLets Blog`,
    description: post.description,
    keywords: post.keywords,
    openGraph: {
      title: post.title,
      description: post.description,
      type: "article",
      publishedTime: post.date,
    },
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getPostBySlug(slug);

  // Drafts are only reachable by direct URL during local review, never listed
  // or indexed — production readers should never see draft: true content.
  if (!post || (post.draft && process.env.NODE_ENV === "production")) {
    notFound();
  }

  const post_ = post!;
  const html = await markdownToHtml(post_.content);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "64px 24px", color: "#f5f5f7" }}>
      <Link href="/blog" style={{ color: "#3b82f6", textDecoration: "none", fontSize: 14 }}>
        ← Back to blog
      </Link>

      <h1 style={{ fontSize: 36, fontWeight: 800, margin: "16px 0 8px" }}>{post_.title}</h1>
      <p style={{ color: "rgba(245,245,247,0.6)", marginBottom: 32 }}>
        {post_.date} · {post_.readingTimeMinutes} min read · {post_.author}
        {post_.draft ? " · DRAFT" : ""}
      </p>

      <article
        style={{ lineHeight: 1.7, fontSize: 17 }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </main>
  );
}

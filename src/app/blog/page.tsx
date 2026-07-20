import type { Metadata } from "next";
import Link from "next/link";
import { getAllPosts } from "@/lib/blog";

export const metadata: Metadata = {
  title: "Blog — BookLets",
  description: "Bookkeeping, tax, and operations guidance for short-term rental hosts.",
};

export default function BlogIndexPage() {
  const posts = getAllPosts();

  return (
    <main
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: "64px 24px",
        color: "#f5f5f7",
      }}
    >
      <h1 style={{ fontSize: 40, fontWeight: 800, marginBottom: 8 }}>BookLets Blog</h1>
      <p style={{ color: "rgba(245,245,247,0.7)", marginBottom: 48 }}>
        Practical bookkeeping and operations guidance for short-term rental hosts and property
        managers.
      </p>

      {posts.length === 0 ? (
        <p style={{ color: "rgba(245,245,247,0.6)" }}>No posts published yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 24 }}>
          {posts.map((post) => (
            <li
              key={post.slug}
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 16,
                padding: 24,
              }}
            >
              <Link
                href={`/blog/${encodeURIComponent(post.slug)}`}
                style={{ color: "#3b82f6", fontSize: 22, fontWeight: 700, textDecoration: "none" }}
              >
                {post.title}
              </Link>
              <p style={{ color: "rgba(245,245,247,0.6)", fontSize: 14, margin: "8px 0 12px" }}>
                {post.date} · {post.readingTimeMinutes} min read
              </p>
              <p style={{ color: "rgba(245,245,247,0.85)" }}>{post.description}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

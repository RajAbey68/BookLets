import type { MetadataRoute } from "next";
import { getAllPosts } from "@/lib/blog";

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = (process.env.BLOG_SITE_URL || "https://booklets.vercel.app").replace(/\/$/, "");
  const posts = getAllPosts();

  return [
    { url: `${siteUrl}/blog`, changeFrequency: "weekly", priority: 0.8 },
    ...posts.map((post) => ({
      url: `${siteUrl}/blog/${encodeURIComponent(post.slug)}`,
      lastModified: post.date,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}

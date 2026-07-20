# Blog population system

A reusable pipeline for populating `/blog` with on-brand posts, inspired by
the "Claude Cowork for marketing" pattern (skills + a content-repurposing
orchestrator + a draft-review gate) but adapted to run inside this repo with
only what's actually available here: Claude Skills triggered in a Claude
Code / Cowork session, and `WebSearch`/`WebFetch` in place of paid
connectors (Firecrawl, Semrush).

## Architecture

```
content/blog/*.md          ← the posts (frontmatter + Markdown body)
src/lib/blog.ts            ← reads/parses/sorts posts, renders (sanitized) Markdown → HTML
src/app/blog/               ← list page, [slug] detail page
src/app/blog/rss.xml/        ← RSS feed
src/app/sitemap.ts          ← Next.js native sitemap (App Router file convention)

.claude/skills/blog-post/            ← voice + structure rules, writes one post
.claude/skills/content-repurposing/  ← gathers a source, hands off to blog-post
.claude/skills/seo-brief/            ← keyword/gap brief via WebSearch (no Semrush)
```

The three skills are the reusable "customization" — the same trigger-a-skill
pattern the source video demonstrates. Editing a skill's `SKILL.md` changes
how every future post in that mode is written.

## How to populate the blog

Inside a Claude Code / Cowork session (the skills auto-trigger from the
descriptions, or invoke them explicitly):
- `/blog-post write about <topic>` — one post, in the house voice.
- `/content-repurposing <PR, doc path, URL, or pasted text>` — gathers the
  source, then hands off to `blog-post`.
- `/seo-brief <topic or existing post>` — keyword ideas and a content-gap
  check via `WebSearch`, not a Semrush-grade report.

Each writes a new `content/blog/YYYY-MM-DD-slug.md` with `draft: true`.
Nothing is ever auto-published — flip `draft` to `false` by hand after
reading the post (see `content/blog/README.md` for the frontmatter schema).

> An earlier revision of this branch also shipped a standalone
> `scripts/blog/generate-post.ts` CLI that called the Anthropic API directly.
> It was removed: sending file content to an API and writing the response
> back to disk is an inherent CodeQL taint pattern (untrusted-network→file,
> file→outbound-request) that this repo's fail-on-alert security gate blocks,
> and the skills already cover the same job without it. Regenerate via the
> skills instead.

## Why the draft gate

The video this system is modeled on treats email drafts as sacrosanct
("never send, reply, modify, or delete") but is looser about publishing
generated blog/social copy straight to a scheduler. We didn't carry that
part over: a wrong claim about a shipped feature is worse in a public blog
post than in a Slack draft, so every generated post lands as a `draft: true`
file for a human to read before it's public. Drafts are excluded from the
index, RSS, and sitemap, and 404 outside local dev.

## Rendering safety

Post Markdown is rendered to HTML through a `unified` pipeline with
`rehype-sanitize` (GitHub's default schema) before it reaches
`dangerouslySetInnerHTML`, and slugs are constrained to a kebab charset
(`^[a-z0-9]+(?:-[a-z0-9]+)*$`) at both listing and lookup so a filename can't
become a `javascript:` href or traverse out of `content/blog/`. The
draft-review gate is the first line of defense against bad content; these are
the second, for content that slips through or is authored by hand.

## What was reused vs. adapted from the video

| Video's tool | Here |
|---|---|
| Higsfield / Blotato / Zapier / Clay MCP connectors | Not applicable — this is a bookkeeping app's content blog, not a full marketing ops stack. Left out rather than stubbed. |
| Firecrawl (scrape a URL/YouTube video) | `WebFetch` in the `content-repurposing` skill. Weaker on JS-heavy pages (can't touch YouTube transcripts) — the skill is told to say so and ask for pasted text instead of fabricating a summary. |
| Semrush (keyword volume, competitor gaps) | `seo-brief` skill using `WebSearch` — qualitative signal only, explicitly not real volume data. |
| Email-voice skill (mined from 20-30 sent emails) | No email corpus to mine here; `blog-post`'s voice section was written directly from this repo's existing tone (README, DESIGN.md) instead. |
| Supabase-backed live dashboard (competitor tracker) | Out of scope for a first pass — would be a reasonable follow-up if this grows into a full content-ops loop. |

## Research: state of the art (reviewed 2026-07-20)

- **Content layer**: `gray-matter` + a `remark`/`rehype` pipeline is the same
  stack as the official
  [`vercel/next.js/examples/blog-starter`](https://github.com/vercel/next.js/tree/canary/examples/blog-starter)
  (which uses `remark-html`). We render through `remark-rehype` +
  `rehype-sanitize` + `rehype-stringify` instead of `remark-html` so the
  output is sanitized before `dangerouslySetInnerHTML` — the one deliberate
  deviation from the starter. If frontmatter correctness ever becomes a real pain
  point (e.g. a missing `date` silently defaulting instead of failing the
  build), [Velite](https://github.com/zce/velite) is the current
  actively-maintained option for compile-time-validated frontmatter via Zod
  schemas — a reasonable upgrade path, not a correction.
- **AI content-generation pattern**: matches
  [`WonderingAboutAI/Blog-Generator-Claude`](https://github.com/WonderingAboutAI/Blog-Generator-Claude)
  (voice/audience baked into the system prompt) and the multi-agent split in
  [`nickwinder/klaude-blog`](https://github.com/nickwinder/klaude-blog)
  (research → write → SEO → social as separate stages). Unlike klaude-blog,
  this system never auto-publishes — see the draft-gate note above.
- **Skill format**: `SKILL.md` frontmatter here follows the documented
  [Agent Skills spec](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
  (`name`, `description`, `name` excludes the words "claude"/"anthropic",
  `description` states both what the skill does and when to use it).
- **Sitemap/RSS**: `app/sitemap.ts` is Next.js's native App Router file
  convention (auto-served at `/sitemap.xml`) rather than a hand-rolled XML
  route, which is what `src/app/sitemap.ts` in this repo does. `rss.xml` has
  no native convention, so it stays a hand-rolled `route.ts`, matching the
  common community pattern for App Router RSS feeds.

---
name: blog-post
description: Write a single BookLets blog post in the house voice and save it to content/blog/. Use whenever the user asks to write, draft, or add a blog post, or names a topic and says "blog" — even if they don't name this skill explicitly.
---

# BookLets blog-post skill

Writes one post for the public blog at `content/blog/` in the BookLets house
voice, with correct frontmatter, and stops — it never publishes, schedules,
or edits ledger/product code.

## Hard rules

1. **Draft only.** Every new post is written with `draft: true`. Never flip
   a post to `draft: false` yourself — that's a human decision, made after
   reading the post.
2. **Never touch code outside `content/blog/`.** This skill writes Markdown
   files. It does not edit `src/`, `prisma/`, or any application code, even
   if the topic is a product feature.
3. **Ground claims in the actual product.** If the post describes a
   BookLets feature, verify the claim against the real source (grep `src/`,
   read the relevant `docs/*.md`) before stating it. Don't invent feature
   behavior. If you're unsure a claim is accurate, hedge it or drop it.
4. **One post per invocation** unless the user explicitly asks for more.

## Voice

- Plain, direct, roughly a 7th–9th grade reading level. No jargon the
  target reader (a short-term-rental host or small property manager, not
  an accountant) wouldn't already know.
- Short paragraphs (2-4 sentences). Section headers (`##`) every 150-250
  words to keep it scannable.
- Lead with the reader's problem, not the product. Explain the fix, then
  mention BookLets — don't open with a pitch.
- No hype adjectives ("revolutionary", "game-changing", "seamless"). No
  exclamation points in body copy.
- It's fine to use "you" and contractions. It's not fine to pad with
  filler sentences that restate the previous sentence.

## Structure

```markdown
---
title: "..."                 # specific, states the reader's outcome, <70 chars
description: "..."           # one sentence, shown on the index page and in search results
date: "YYYY-MM-DD"            # today's date
tags: ["...", "..."]          # 2-4 short lowercase tags
keywords: ["...", "..."]      # 2-5 phrases a reader would actually search for
author: "BookLets Team"
draft: true
---

Opening paragraph: the reader's problem in concrete terms, no throat-clearing.

## A section per sub-point

Body content. GitHub-flavored Markdown — lists, code fences, tables all
render fine through the site's remark pipeline.

## Closing

A short, specific next step (not a generic "get started today"). If it's a
BookLets feature, say exactly where to find it in the product.
```

Target length: 500-900 words. Longer only if the topic genuinely needs it —
don't pad to hit a number.

## Output

Save to `content/blog/YYYY-MM-DD-slug.md`, where `slug` is a short kebab-case
summary of the title (the filename IS the URL — see `content/blog/README.md`
for the schema). Confirm the file path back to the user; do not attempt to
open a PR or deploy.

## Example trigger → output

> "write a blog post about why hosts should reconcile their books monthly, not just at tax time"

→ `content/blog/2026-07-20-why-monthly-reconciliation-beats-tax-time-scramble.md`,
draft: true, in the voice and structure above.

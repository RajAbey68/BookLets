---
name: seo-brief
description: Produce a short SEO/AI-search brief for an existing blog post or a planned topic, using WebSearch instead of a paid tool like Semrush. Use when the user asks for keyword ideas, an SEO review, or "will this rank" for something in content/blog/.
---

# SEO brief (no paid tooling required)

Approximates what a tool like Semrush gives you — target keywords, gaps,
and a title/description check — using only `WebSearch` and `WebFetch`,
which are already available in this environment. It's directionally useful,
not a replacement for real keyword-volume data; say so in the output.

## Steps

1. **Identify the topic.** Either an existing file in `content/blog/`
   (read its frontmatter + body) or a topic the user describes.
2. **Search for how people actually phrase the problem.** Run 2-4
   `WebSearch` queries using question phrasing a reader would type
   ("how do I ...", "why does ...", "best way to ..."), not just the
   product's internal terminology. Note recurring phrases — those are
   candidate `keywords`.
3. **Spot-check 2-3 top-ranking results** with `WebFetch` for the same
   query. Note what they cover that the draft doesn't, and vice versa —
   that's the content gap, not a reason to copy them.
4. **Check the on-page basics** against the draft (or planned title):
   - Title: specific, states the outcome, ideally under 60 characters.
   - Description (meta description / frontmatter `description`): one
     sentence, under 155 characters, states the payoff — not a restatement
     of the title.
   - At least one `##` heading phrased close to a real search query.
5. **Write the brief** as a short Markdown summary (not a file, unless the
   user asks to save it): target keywords, 1-2 content gaps found, and
   specific title/description suggestions if the current ones are weak.

## Guardrails

- Don't claim specific search volumes or difficulty scores — `WebSearch`
  doesn't give you that data, and inventing numbers would be worse than
  omitting them. Describe findings qualitatively ("this phrasing shows up
  across multiple top results" rather than "1,200 searches/month").
- This is a brief, not a rewrite. Hand suggestions back to the `blog-post`
  skill (or the user) rather than editing the post yourself.

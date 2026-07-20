---
name: content-repurposing
description: Turn one source (a shipped feature/PR, a changelog entry, a doc, or a URL) into a BookLets blog post by orchestrating the blog-post skill. Use when the user gives a source and asks to "repurpose", "turn this into a blog post", or "write about" a recent change without specifying the exact copy.
---

# Content repurposing orchestrator

One input in, one blog post out. This skill is a thin wrapper: it gathers
context, then hands off to the `blog-post` skill to do the actual writing.
It does not have its own voice rules — `blog-post` owns those.

## Accepted inputs

- A git commit / PR reference or description of a shipped feature
  ("write about the WhatsApp export feature we just shipped")
- A path to a doc in this repo (`docs/*.md`, `README.md`)
- A URL (fetch it with `WebFetch`; if the page is JS-rendered and comes back
  empty, say so rather than guessing at the content)
- Pasted text (a transcript, an email, notes)

## Steps

1. **Gather the source material.**
   - Repo feature: read the actual diff/code (`git show`, `git log -p`, or
     `Read` the changed files) — don't work from the commit message alone,
     it's often terser than the real behavior.
   - Doc path: `Read` it directly.
   - URL: `WebFetch`. If it fails or returns boilerplate/JS-shell content,
     tell the user and ask them to paste the content instead of fabricating
     a summary.
   - Pasted text: use as-is.
2. **Extract 1-3 concrete, verifiable claims** from the source — the thing
   a reader actually cares about, not a feature-tour of every detail.
3. **Invoke the `blog-post` skill** with those claims as the brief. Let it
   own voice, structure, and frontmatter.
4. **Report back** the file path and a one-line summary of what the post
   covers. Do not also produce a second copy of the content outside the
   file the `blog-post` skill wrote.

## Guardrails

- If the source material doesn't support a genuinely useful post (e.g. a
  purely internal refactor with no user-facing angle), say so instead of
  padding a post out of nothing.
- Never fabricate metrics, dates, or feature behavior not present in the
  source. This skill is grounding for `blog-post`, not a substitute for
  checking facts.

# BookLets — NotebookLM Source Bundle

This folder is the **canonical source set** for the BookLets NotebookLM
assistant. Everything an LLM is allowed to answer from lives here (or is
linked from here).

> **Read first:** [`../LLM-ASSISTANT.md`](../LLM-ASSISTANT.md) explains the
> overall pattern — why NotebookLM, what the system prompt is, how to share
> the notebook.

---

## Load order

When building the notebook, add sources in this order. Order doesn't affect
retrieval but it keeps the left rail tidy and predictable.

### Internal (in this repo)
| # | Source | Type in NotebookLM | What it covers |
|---|--------|--------------------|----------------|
| 1 | [`../HELP.md`](../HELP.md) | Paste text (or upload as PDF) | Screens, workflow, FAQ, troubleshooting, chart of accounts, policies, glossary. |
| 2 | [`../LLM-ASSISTANT.md`](../LLM-ASSISTANT.md) | Paste text | This guide — included so the assistant can answer meta-questions about itself. |
| 3 | [`../booklets-walkthrough.html`](../booklets-walkthrough.html) | Save as PDF then upload | Visual deck for the bookkeeper / accountant. |
| 4 | [`../../prisma/seed.ts`](../../prisma/seed.ts) (just the leading comment block) | Paste text | Canonical chart-of-accounts rationale — FX policy, payroll split, petty cash threshold, booking-month attribution. |

### External (tier-1 public sources)
Add these as **Website** sources or download the canonical PDF and upload.

| # | Source | URL hint | Why |
|---|--------|----------|-----|
| 5 | **SLFRS — Sri Lanka Financial Reporting Standards** | CA Sri Lanka publications page, `casrilanka.com` | Canonical accounting framework. |
| 6 | **Sri Lanka IRD — APIT tables** (current year) | `ird.gov.lk` → *Publications → Tax tables* | Payroll questions. |
| 7 | **EPF Sri Lanka — contribution guide** | Central Bank of Sri Lanka EPF site | Validates the 8% + 12% split. |
| 8 | **ETF Board — contribution guide** | `etfb.lk` | Validates the 3% employer-only contribution. |
| 9 | **QuickBooks Online — Import journal entries from CSV** | Intuit Help Centre | Export-to-QBO questions. |
| 10 | **Hostaway documentation** (optional) | `hostaway.com/help` | Channel-side fields and reservation lifecycle. |

> **Tier-1 means**: official, primary-source, public. **Not** secondary
> commentary, **not** blog posts, **not** community forums. Anything that
> isn't tier-1 doesn't go in.

---

## After loading

1. Open **Notebook settings** and paste the *System instructions* block
   from [`../LLM-ASSISTANT.md`](../LLM-ASSISTANT.md) §5.
2. Open the **Notebook guide** and confirm the auto-generated summary
   describes BookLets correctly (not, e.g., "a generic accounting tool").
3. Run the five sample questions from `LLM-ASSISTANT.md` §6 and confirm
   the answers cite the right sources.
4. **Share** with Viewer access to the bookkeeper and accountant.

---

## When something here changes

1. Pull request → review → merge to `main`.
2. Operator opens the notebook, finds the changed source in the left rail,
   deletes it, re-uploads from the new version in `main`.
3. NotebookLM re-indexes within ~1 minute.
4. Done — notebook URL is unchanged.

No automated sync. If automation becomes critical, that's the trigger for
shipping the in-app chat (roadmap phases P9–P11), which reads directly
from the live BookLets database with the same grounding rules.

---

## Why a bundle folder at all?

Two reasons:
1. **Discoverability.** The operator doesn't have to hunt across the repo
   to find what to upload — the checklist is here.
2. **Snapshotting.** When sources need extra prep before upload (e.g. a
   trimmed extract of `seed.ts`, or a converted PDF), the prepped file
   lives here so the prep is reproducible.

Today the bundle contains only this README. Add the trimmed extracts and
prepped PDFs to this folder as the source set evolves.

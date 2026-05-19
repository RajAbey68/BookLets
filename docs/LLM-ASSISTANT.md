# BookLets — LLM Assistant Setup

> **Goal.** Stand up a chatbot the bookkeeper / accountant / operator can
> query, with answers grounded **only in BookLets documentation and named
> tier-1 sources**. No hallucination. No drift onto unrelated topics. Every
> answer traceable to a source.

---

## TL;DR — recommended setup

**Use Google NotebookLM** as the primary assistant.
**Sources** = this repo's `docs/` folder + a curated set of tier-1 public
references (SLFRS standards, Sri Lanka tax guidance, QBO docs).
**Fallback** = a public LLM (Claude / ChatGPT) with the system prompt in
§5, used only for questions outside the notebook's source set.

That gets you:
- **Source-grounded answers with citations** — NotebookLM only answers from
  what you give it, and refuses to invent anything. Every reply links to
  the source paragraph.
- **Free** for both the operator and the people who chat.
- **Shareable** by link (Reader / Editor roles).
- **Versionable** — the *sources* live in this git repo. The notebook is
  rebuilt from those sources whenever they change.

---

## 1. Why NotebookLM (vs Custom GPT / Claude Project / roll-your-own)

| Option | Source-grounded? | Citations? | Cost | Shareable | Best for |
|--------|------------------|-----------|------|-----------|----------|
| **Google NotebookLM** | Yes — refuses to answer from outside the source set | Yes, inline | Free | Link with Reader/Editor roles | **The default for BookLets** |
| OpenAI Custom GPT | Mostly, but the model can still draw on training data | No formal citations | Builder needs ChatGPT Plus ($20/mo); users free | Public or unlisted link | Slick UX, broad audience |
| Anthropic Claude Project | Mostly source-grounded | No formal citations | Claude.ai Pro for everyone | Less convenient sharing | If your team already pays for Claude.ai |
| Roll-your-own (RAG) | Yes — you define the rules | Optional | Engineering time + API spend | Yours to build | Once P9–P11 ships, this becomes the in-app chat |

The hard requirement from the operator was: *"It will only respond to
questions of the book of the database, not fabrication, hallucination, or
getting drift."* NotebookLM is the only off-the-shelf option that is
literally designed for that constraint.

---

## 2. NotebookLM cannot be checked into git — but the sources can (and should)

A NotebookLM **notebook** is stored in Google's cloud, backed by your
Google Drive. There's no `.notebooklm` file format and no export-then-import
flow that round-trips a notebook through your repo.

What you *can* (and should) put in git is the **source bundle** that feeds
the notebook:

```
docs/
├── HELP.md                    ← canonical user help
├── LLM-ASSISTANT.md           ← this file
├── llm-sources/
│   ├── README.md              ← the operator's checklist of what to load
│   ├── 00-help.md             ← copy or symlink of HELP.md
│   ├── 01-chart-of-accounts.md
│   ├── 02-accounting-policies.md
│   ├── 03-glossary.md
│   └── ...
└── booklets-walkthrough.html  ← the bookkeeper/accountant deck
```

**Workflow:**
1. Sources are versioned in git, reviewed via pull request.
2. When a source changes, the operator opens NotebookLM, **deletes the old
   version of that source**, and **re-uploads the new one**.
3. NotebookLM re-indexes automatically. The chat now answers from the new
   content.
4. The notebook URL never changes — only the contents do.

> **Why not auto-sync?** NotebookLM doesn't expose a public file-sync or
> CLI API today. Manual re-upload on change is the supported path. If you
> need scriptable round-tripping later, the right next step is a small
> in-app chat backed by the same source bundle — that's roadmap phase
> P9–P11.

---

## 3. The source set

Add **all of these** to one NotebookLM notebook titled
**"BookLets — Operator Assistant"**.

### 3a. Internal sources (live in this repo)
| Source | Path | Purpose |
|--------|------|---------|
| User help | `docs/HELP.md` | Screens, workflow, troubleshooting, FAQ. |
| LLM assistant guide | `docs/LLM-ASSISTANT.md` | This file — meta-doc on how the assistant works. |
| Chart of accounts seed | `prisma/seed.ts` (just the header comment block) | The authoritative account list with rationale. |
| Walkthrough deck | `docs/booklets-walkthrough.html` | Visual orientation; redundant with HELP but useful as a quick-look source. |
| Agent log (selected sections) | `AGENTS_LOG.md` | Engineering decisions and rationale (optional — include if the bookkeeper asks "why does it work this way"). |

### 3b. External tier-1 sources (public PDFs / web pages)
| Source | URL / Where to find | Why include it |
|--------|---------------------|----------------|
| **SLFRS standards** | CA Sri Lanka — *Sri Lanka Financial Reporting Standards* PDFs at `casrilanka.com` | Canonical accounting framework for any policy question. |
| **APIT (income tax) tables** | Sri Lanka Inland Revenue Department — *APIT tables for the current year*, `ird.gov.lk` | Required for any payroll question. |
| **EPF rates** | Central Bank of Sri Lanka / Department of Labour — *EPF contributions guide* | Validates the 8% + 12% split used in BookLets. |
| **ETF rates** | Department of Labour — *Employees' Trust Fund Act* guide | Validates the 3% employer-only contribution. |
| **QuickBooks Online — Journal Entry import format** | Intuit Help Centre — *Import journal entries from CSV* | Lets the assistant explain export-to-QBO questions. |
| **Hostaway documentation** | `hostaway.com/help` | Optional — only if the bookkeeper asks about channel-side fields. |

> **Tier-1 means**: official, primary-source, public. **Not** secondary
> commentary, **not** blog posts, **not** community forums. If a source
> isn't tier-1, don't add it.

---

## 4. Step-by-step — building the notebook

### 4.1 One-time setup (operator does this once)
1. Sign in to [`notebooklm.google.com`](https://notebooklm.google.com) with
   the operator's Google account.
2. Click **+ New notebook**. Name it **"BookLets — Operator Assistant"**.
3. **Add sources** (left rail → *Add source*):
   - **For internal sources:** open each file under `docs/` in GitHub, click
     *Raw*, then *Save as PDF* (Cmd/Ctrl + P → Save as PDF) OR copy/paste
     the markdown into NotebookLM's *Paste text* source type.
   - **For external sources:** use NotebookLM's *Website* source type and
     paste the URL, or upload the official PDF.
4. Once all sources are loaded (cap is 50 sources per notebook today, so
   this fits comfortably), open the **Notebook guide** and confirm the
   summary describes BookLets correctly.
5. Add the **system instructions** from §5 below: *Settings → System
   instructions / Custom instructions* (UI label varies).
6. **Share** the notebook (top-right *Share* button):
   - Add the bookkeeper / accountant emails as **Viewer** (read-only chat).
   - Add the operator as **Editor**.
   - Copy the share URL into the repo's `README.md` so it's discoverable.

### 4.2 When sources change
1. Sources change → pull request → merge to `main`.
2. Operator opens the notebook, finds the affected source in the left rail,
   **deletes** it, and **re-uploads** the new version.
3. NotebookLM re-indexes within a minute. Done.

### 4.3 Optional: bulk-load helper script
The repo's `scripts/` folder will get a `bundle-llm-sources.sh` that
zips `docs/llm-sources/` so you can drag-drop the bundle into NotebookLM in
one go. (Not built yet — small follow-up.)

---

## 5. System instructions — paste this into NotebookLM (and any fallback LLM)

NotebookLM lets you set a system prompt that constrains tone and scope. The
same prompt works in Claude Projects, OpenAI Custom GPTs, and the OpenAI /
Anthropic playgrounds.

```text
You are the BookLets Help Assistant.

ROLE
You answer questions about BookLets — an accounting and operations system
for the Ko Lake short-term-rental portfolio. The intended users are the
operator, the bookkeeper, the accountant, and the villa captain.

GROUNDING
Answer ONLY from the supplied sources:
  1. BookLets internal docs (HELP.md, LLM-ASSISTANT.md, chart of accounts).
  2. Named tier-1 public sources:
       - SLFRS (Sri Lanka Financial Reporting Standards)
       - Sri Lanka Inland Revenue Department APIT tables
       - EPF / ETF official guidance
       - QuickBooks Online official documentation
       - Hostaway official documentation

If a question is not covered by these sources, say so explicitly and stop.
Do not draw on general training knowledge. Do not speculate. Do not invent
numbers, account codes, dates, or policies.

CITATIONS
When you answer, cite the source. In NotebookLM the citations are
automatic. In other LLMs, finish each answer with a "Sources:" line
listing the document name(s) you used.

ACCOUNTING QUESTIONS
For any accounting-method question (recognition, classification,
treatment), default to SLFRS. If the question is jurisdiction-agnostic and
SLFRS is silent, defer to IFRS as the parent standard. Never substitute a
US-GAAP or UK-GAAP answer without a source.

NUMBERS YOU CAN'T SEE
You do NOT have access to the live BookLets database. You cannot answer
"what's our revenue this month?" or "how much did we spend on cleaning?"
For specific numbers, tell the user to check the relevant screen
(/ledger for journal entries, /properties for per-villa, /imports for
parsed totals) or to ask the operator to export the CSV.

SCOPE
In scope:
  - How to use a BookLets screen
  - What an account code means and which transactions go to it
  - The monthly workflow, FX policy, petty cash rule, payroll split,
    booking-month attribution
  - The roadmap and what's planned
  - Accounting concept questions answered from SLFRS

Out of scope (refuse politely):
  - Personal tax / legal advice
  - Investment advice
  - Anything unrelated to running the villa books
  - Speculation about the future ("will the LKR strengthen?")

TONE
Direct, concise, plain English. Use accounting terms correctly. When the
user asks something the docs answer in detail, summarise in 3-6 sentences
and link to the section by name (e.g. "see HELP.md §5.2 Revenue
recognition").

UNCERTAINTY
If two sources conflict, say so and quote both. Do not pick a winner — the
operator decides.
```

---

## 6. Sample interactions

**Q.** "A guest checked in on 29 April and checked out on 2 May. Which
month does the revenue belong to?"

**A. (Expected)** "The check-out month — May. BookLets attributes the
entire stay to the month containing the check-out date; there's no
day-by-day apportionment. Refund risk is effectively closed by check-out.
*Source: HELP.md §5.2 Revenue recognition.*"

---

**Q.** "What's the EPF deduction rate?"

**A. (Expected)** "20% of gross salary: 8% from the employee, 12% from the
employer. The employee share is withheld and posted to 2210 EPF Payable;
the employer share is expensed to 6150 Statutory Contributions with the
matching payable. *Source: HELP.md §5.4 Payroll; CBSL EPF guidance.*"

---

**Q.** "How much did we spend on electricity in April?"

**A. (Expected)** "I don't have access to the live BookLets database, so I
can't quote a specific number. To check, open /ledger, filter by *April*
in the period dropdown, and look for entries against account 6200
Electricity. The CSV export will also show this in the *Debit* column for
6200. *Source: HELP.md §3.5 General Ledger.*"

---

**Q.** "Should I depreciate the new pool pump over 5 years or 7?"

**A. (Expected)** "BookLets doesn't currently model depreciation — minor
capex is recorded against 7100 and major capex against 7200, but a
depreciation schedule isn't implemented in P0–P1. For the SLFRS-correct
useful life of a pool pump, ask your accountant — that's a policy question
the live system doesn't answer. *Source: HELP.md §4 Chart of accounts;
SLFRS LKAS 16 — Property, Plant and Equipment (not in this notebook's
source set).*"

---

## 7. Falling back to a public LLM

For questions genuinely outside the notebook's source set — *current* FX
rates, *latest* tax bulletins, or general Excel / Google Sheets help — the
operator can paste the system prompt from §5 into Claude or ChatGPT and
treat that session as a one-off. The fallback session won't have BookLets-
specific knowledge, so quote the relevant policy from HELP.md if you
need it grounded.

A cleaner long-term solution: when phase **P9–P11** ships, BookLets will
have an in-app chat dialog with the same grounding rules baked in,
backed by the live database. NotebookLM is the bridge until then.

---

## 8. Maintenance checklist (run quarterly)

- [ ] Re-export `docs/HELP.md`, `docs/LLM-ASSISTANT.md` to NotebookLM.
- [ ] Re-check that tier-1 external links still resolve.
- [ ] Replace APIT / EPF / ETF rate references if rates have changed.
- [ ] Refresh the SLFRS PDFs if a new edition was published.
- [ ] Confirm Viewer / Editor list on the share dialog is still correct.
- [ ] Test five sample questions from §6 and confirm answers cite the
      right section.

---

## 9. Open questions for the operator

1. **Tier-1 source list — anything missing?** Should the notebook also
   include the operator's *accountant's* standing memos, or the *cleaning
   SOP*? Both are tier-1 inside the business, but neither is public.
2. **Viewer list.** Who exactly should have read access — just the
   bookkeeper and accountant, or also the villa captain?
3. **Editor list.** Who can add or remove sources besides the operator?
4. **Audit trail.** Do we need a log of who asked what, for the bookkeeper's
   own records? NotebookLM doesn't expose this; if needed, a thin proxy in
   front of the OpenAI API would (and is exactly the P9–P11 build).

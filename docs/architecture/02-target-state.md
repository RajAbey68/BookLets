# BookLets — Target-State Architecture

> Where the system is going across phases P2–P11. Read
> [`01-current-state.md`](01-current-state.md) first for the baseline.
> [`03-review-and-risks.md`](03-review-and-risks.md) covers what could
> go wrong on the way there.

This document includes the explicit decisions on **NoSQL** and
**small language models** the operator asked about. See §8 and §9.

---

## 1. Target-state shape

```mermaid
flowchart LR
  subgraph Browser
    UI["Browser"]
    CHAT["In-app chat widget<br/>(P9–P11)"]
  end

  subgraph Vercel["Vercel — Next.js"]
    EDGE["Edge middleware"]
    SSR["Server Components + Actions"]
    API["API route handlers"]
    BG["Background workers<br/>(Vercel Cron / Inngest)"]
  end

  subgraph Supabase["Supabase — eu-west-1"]
    PG[("Postgres 16<br/>+ pgvector<br/>+ RLS<br/>+ JSONB for flex schemas")]
    STORE[("Supabase Storage<br/>(receipts, exports)")]
  end

  subgraph AI["AI services"]
    NB[("NotebookLM<br/>(today)")]
    LLM[("Frontier LLM API<br/>(Claude / GPT / Gemini)")]
    EMB[("Embedding model<br/>(hosted or local Gemma)")]
    OCR[("Vision LLM for OCR<br/>(Gemini / Claude)")]
  end

  subgraph Partners["Partners"]
    HA[("Hostaway")]
    GD[("Google Drive<br/>(receipt inbox)")]
    BANK[("Bank statements<br/>(CSV / Plaid-equiv)")]
    FX[("FX rate feed<br/>(exchangerate.host)")]
    QBO[("QuickBooks Online")]
  end

  UI --> EDGE
  CHAT --> SSR
  EDGE --> SSR
  SSR --> PG
  SSR --> STORE
  SSR --> LLM
  SSR --> EMB
  API --> PG
  BG --> PG
  BG --> HA
  BG --> GD
  BG --> BANK
  BG --> FX
  BG --> OCR
  SSR --> QBO
  UI -. "manual export" .-> QBO
  UI -. "today" .-> NB
```

Compared to the current state: **background workers**, **Supabase
Storage**, **pgvector**, **AI services panel**, and a wider set of
**partner integrations** (Drive, bank, FX feed, QBO API).

---

## 2. What ships in each phase

| Phase | Feature | Architecture impact |
|-------|---------|---------------------|
| **P2** | Confirm-and-post on `/imports` | Adds `JournalEntry.sourceHash` idempotency, new server action `postParsedSpreadsheet`. No new infra. |
| **P3** | Editable grid before posting | New client component with optimistic updates. No new infra. |
| **P4** | Bank reconciliation | New `BankTransaction` table; CSV import endpoint; matching algorithm in a server action. New background job to ingest scheduled bank exports. |
| **P5** | Month-close + accountant pack | New `Period` table, FX-rate snapshot stored on close, exporter generates trial balance + P&L + balance sheet PDFs into Supabase Storage. |
| **P6** | STR dashboards (channel mix, seasonality) | New aggregated views (Postgres materialised views, refreshed nightly by background worker). |
| **P7** | Capex tracker + forecast editor | New tables: `CapexItem`, `Forecast`. No new infra. |
| **P8** | Receipts pipeline (Drive → OCR → P/H flag → Sinhala translation) | Adds **Supabase Storage**, **vision LLM API**, **background worker**, **Google Drive watcher**. Receipts metadata in Postgres JSONB. |
| **P9–P11** | In-app AI chat — DB-grounded, SLFRS-sourced | Adds **pgvector**, **embedding pipeline**, **RAG retrieval**, **chat history table**. NotebookLM retires here. |

---

## 3. Data-model evolution

```mermaid
erDiagram
  JournalEntry ||--o{ JournalLine : contains
  JournalEntry }o--|| Period : booked_in
  Expense ||--o{ JournalEntry : generates
  Expense }o--|| Receipt : optionally_has
  Receipt }o--|| Storage : stored_in
  BankTransaction }o--o{ JournalEntry : matched_to
  Period ||--o{ FxRateSnapshot : freezes
  Document ||--o{ DocChunk : split_into
  DocChunk }o--|| Embedding : indexed_by
  ChatSession ||--o{ ChatTurn : has

  JournalEntry {
    string id PK
    string orgId
    date date
    string memo
    string status
    string source
    string sourceHash
    string periodId FK
  }
  Period {
    string id PK
    date startDate
    date endDate
    string status "OPEN / CLOSED"
    string closedById FK
  }
  FxRateSnapshot {
    string id PK
    string periodId FK
    string fromCcy
    string toCcy
    decimal rate
    string method "MONTH_END_SPOT / MONTH_AVG"
    datetime fetchedAt
  }
  BankTransaction {
    string id PK
    string orgId
    date date
    string description
    decimal amount
    string statementRef
    string reconciledEntryId FK
  }
  Receipt {
    string id PK
    string expenseId FK
    string storageObjectId
    string evidenceType "PRINTED / HANDWRITTEN / MISSING / NA"
    string ocrText
    string ocrLanguage
    jsonb ocrRaw
    string translatedText
  }
  Document {
    string id PK
    string title
    string source "HELP_MD / SLFRS_LKAS16 / ..."
    string version
  }
  DocChunk {
    string id PK
    string documentId FK
    int chunkIndex
    string text
  }
  Embedding {
    string id PK
    string chunkId FK
    vector embedding "pgvector(768)"
    string model
  }
  ChatSession {
    string id PK
    string userId FK
    string orgId FK
  }
  ChatTurn {
    string id PK
    string sessionId FK
    string role "user / assistant"
    string content
    jsonb citations
    jsonb retrievedChunkIds
  }
```

New tables, no destructive changes to existing ones. Migrations are
additive in every phase.

---

## 4. The AI assistant — NotebookLM bridge → in-app chat

```mermaid
flowchart LR
  subgraph Today["Today (P0–P1)"]
    D1["docs/HELP.md<br/>docs/LLM-ASSISTANT.md"] -->|operator uploads| NB[("NotebookLM notebook<br/>+ tier-1 sources")]
    USER1["Bookkeeper / accountant"] -->|chat in browser| NB
  end

  subgraph Future["Target (P9–P11)"]
    REPO["docs/* + DB schema"] -->|nightly job| EMB["Embedding pipeline"]
    EMB --> VEC[(pgvector index)]
    USER2["Operator / bookkeeper"] -->|asks question in BookLets| RAG["Retriever<br/>(top-k relevant chunks + live DB queries)"]
    RAG --> VEC
    RAG --> LIVE[(Postgres — live numbers)]
    RAG --> LLM[("Frontier LLM<br/>system prompt + retrieved context")]
    LLM -->|cited answer| USER2
  end
```

**Grounding rules carry forward unchanged from
[`../LLM-ASSISTANT.md`](../LLM-ASSISTANT.md):**
- Answer only from sources (docs) and live DB rows.
- Cite the source or query of every fact.
- Refuse questions outside scope.
- For accounting methodology, defer to SLFRS.

**The transition:** NotebookLM is the "good enough" assistant *until*
P9–P11 ships. The same source set used in NotebookLM becomes the
embedded source set inside BookLets. Operators don't lose continuity —
the in-app chat is a strict superset because it adds live database
access.

---

## 5. Receipt pipeline (P8) in detail

```mermaid
flowchart LR
  CAPTAIN["Villa captain<br/>uploads to Google Drive<br/>folder per quarter"] --> DRIVE[("Google Drive")]
  DRIVE -->|watcher cron| WORKER["Background worker<br/>(Vercel Cron + Inngest)"]
  WORKER -->|copy| BLOB[("Supabase Storage<br/>(canonical store)")]
  WORKER -->|OCR| OCR[("Vision LLM<br/>Gemini Flash / Claude Haiku")]
  OCR --> CLASSIFY["Classifier<br/>P / H / Missing"]
  CLASSIFY --> TRANSLATE{"Language?"}
  TRANSLATE -->|Sinhala| TR[("Translator<br/>frontier LLM / DeepSeek")]
  TRANSLATE -->|English| SKIP[skip]
  TR --> WRITE
  SKIP --> WRITE
  WRITE["Write Receipt row<br/>(metadata + OCR text + translation)"] --> PG[(Postgres JSONB)]
  PG --> MATCH["Match to existing Expense<br/>(date + amount tolerance)"]
  MATCH --> READY[("Bookkeeper review queue")]
```

Receipts that can't be auto-matched land in a review queue surfaced in
the in-app dashboard. The classifier "P/H" output is stored on
`Receipt.evidenceType`.

---

## 6. Bank reconciliation (P4)

```mermaid
flowchart LR
  BANK["Bank statement CSV<br/>(or open-banking feed later)"] -->|/api/import/bank| INGEST["Ingest worker"]
  INGEST --> BT[("BankTransaction table")]
  BT --> MATCH["Matcher<br/>(date ± 3d, amount ±0.5%, memo fuzzy)"]
  MATCH -->|auto-match| LINK["Set BankTransaction.reconciledEntryId"]
  MATCH -->|low-confidence| QUEUE[("Reconciliation queue<br/>(bookkeeper UI)")]
  QUEUE -->|manual link or create entry| LINK
```

Source-of-truth stays inside BookLets. The bank feed is a read-only
view; nothing about the ledger changes except gaining a foreign-key
pointer from the journal entry to its bank line.

---

## 7. FX-rate handling (supports P5 month-close)

```mermaid
flowchart LR
  CRON[("Daily cron — 23:55 LKT")] --> FETCH["Fetch LKR/USD spot from exchangerate.host"]
  FETCH --> RATES[("FxRate daily table<br/>(rolling)")]
  CLOSE["Operator runs Month Close"] --> SNAP["Snapshot rate<br/>(month-end spot OR monthly average)"]
  RATES --> SNAP
  SNAP --> FX[("FxRateSnapshot<br/>linked to Period")]
  FX --> REPORT[("Reports re-rendered with USD columns")]
```

The chosen method (`MONTH_END_SPOT` vs `MONTH_AVG`) is stored on the
snapshot row so historical reports remain reproducible even if the
policy changes later.

---

## 8. Decision: NoSQL (MongoDB) — **NO**

| Question | Answer |
|---------|--------|
| Where would Mongo go? | Receipt OCR payloads, audit logs, parsed spreadsheet snapshots, chat history. |
| What does Postgres do instead? | **JSONB columns** on `Receipt.ocrRaw`, `JournalEntry.metadata`, `ChatTurn.citations`. Full GIN indexes on JSONB keep query performance acceptable. |
| What does Mongo cost us? | Two backup pipelines. Two query languages. Loss of transactional consistency between ledger rows and their metadata. Cross-store joins move into application code. |
| When would we revisit? | If receipt document scale crosses ~10⁷ rows (Ko Lake won't), or if the team builds a separate product that's truly document-first. |

**Verdict:** Postgres + JSONB covers every legitimate "we need flexible
schema" case. Add Mongo only if we discover a real workload Postgres
can't handle — and even then, prefer a managed Postgres extension
(e.g. pgvector, partitioning) before adding a second store.

---

## 9. Decision: Small language model (Gemma) — **NOT YET**

| Question | Answer |
|---------|--------|
| Where could Gemma fit? | (a) Local **embedding generation** for RAG retrieval, (b) routing/classification (P/H flag, "is this a question I should escalate?"), (c) cheap Sinhala translation, (d) offline-capable receipt OCR post-processing. |
| Why not now? | At Ko Lake's volume, frontier APIs (Gemini Flash, Claude Haiku, GPT-4o-mini) cost less than hosting a GPU for self-hosted Gemma. Quality on Sinhala translation is materially better with frontier models. The operational cost of running a model server (deployment, version pinning, GPU node) outweighs the API spend until usage scales. |
| When would we revisit? | Monthly LLM spend > ~$100–200; or a strict data-residency requirement that forbids data leaving the operator's infrastructure. |
| First place an SLM lands if we adopt one | **Embedding model**, not chat model. Embeddings are the cheapest-per-query frontier-API cost and the easiest to self-host with no quality regression. `EMB` in the target-state diagram is deliberately ambiguous so we can swap a hosted embedding API for a local Gemma model later. |

**Verdict:** Use frontier LLM APIs for OCR, translation, and chat. Use
hosted embeddings for retrieval. Architect so the embedding provider is
replaceable. Revisit self-hosting Gemma when usage justifies it.

---

## 10. Multi-tenancy promotion path

We're single-tenant today but the schema already carries `orgId`
everywhere. Promoting to multi-tenant is:

```mermaid
flowchart LR
  STEP1["Enable RLS policies<br/>on every domain table<br/>(already in schema, audit usage)"] --> STEP2["Auth callback maps<br/>JWT.user → Membership → orgId<br/>set as transaction-local context<br/>(SET LOCAL app.org_id)"]
  STEP2 --> STEP3["All Prisma queries inherit<br/>RLS-enforced WHERE org_id = current_setting('app.org_id')<br/>(transaction-scoped, safe with PgBouncer)"]
  STEP3 --> STEP4["Add org-creation flow<br/>+ invite flow<br/>(no schema migration needed)"]
  STEP4 --> STEP5["Stripe billing on Organization<br/>(future)"]
```

No data migration needed — only policies, transaction-local context, and
UI for org switching. Use `SET LOCAL app.org_id = '…'` inside each
transaction (not `SET` / session GUC) — PgBouncer runs in transaction mode
and session state is not preserved across pooled connections.

---

## 11. Observability — what we add as we grow

| Stage | Tool | Why |
|------|------|-----|
| P2 | Structured logging via `pino` to Vercel logs | Replace `console.log`, get JSON parsing for free. |
| P4 | Sentry (or equivalent) for client + server errors | Bank reconciliation surfaces exceptions; bookkeeper needs to see them. |
| P5 | Vercel Analytics for page load metrics | Once external accountants use the system regularly. |
| P9 | OpenLLMetry / langfuse for LLM call traces | Required as soon as the in-app chat is live — debugging without traces is painful. |

---

## 12. What the architecture does NOT become

- **Not microservices.** Single Next.js app stays. The only service split
  we'd accept is a separate **background worker process** for jobs that
  shouldn't run in serverless functions (long OCR batches).
- **Not multi-cloud.** Vercel + Supabase is the platform. Migration cost
  is high and the lock-in is acceptable for the operating scale.
- **Not real-time / websockets.** No live collaboration requirement.
  Polling for sync status is fine.
- **Not its own auth system.** Auth.js + Google + allow-list is enough.
  If we ever need SAML, we lean on Auth.js providers, not a custom
  implementation.

# BookLets — Sandbox (Staging) → Main Books: Ingestion, Review & Ledger Diligence

> **Canonical repo reference** for BookLets' two-tier accounting model: where raw data
> first lands (the "sandbox" / staging area, typically a WhatsApp `.zip` export) and where
> it is pushed after human review (the "main books" / posted ledger), plus the diligence
> that moves numbers between them.
>
> **Provenance.** Compiled 2026-07-29 from a code scan of `main`. Every claim cites
> `file:line`. Companion docs: `docs/RUNTIME-SERVICE-MAP.md` (external services),
> `docs/ARCHITECTURE-OCR-PIPELINE.md` (OCR capability deep-dive). Tracking: Linear
> RAJ-719 / RAJ-725 / RAJ-687.
>
> **One-sentence summary.** The "sandbox" is `JournalEntry` rows with `status='DRAFT'`
> (quarantined from reports); the "main books" is `status='POSTED'` (feeds reports,
> immutable); the **only** way out of the sandbox is a distinct human's 4-eyes approval —
> no automation can POST.

---

## 0. TL;DR

- **Sandbox = DRAFT `JournalEntry` rows.** Every automated/imported record lands as
  `status: 'DRAFT'` and is quarantined from all reports until reviewed.
- **Main books = POSTED `JournalEntry` rows** + derived Trial Balance / P&L / Balance
  Sheet / General Ledger. Only POSTED flows into reports; POSTED is immutable.
- **The only door sandbox → main books is 4-eyes human approval** — a *compile-time*
  guarantee (`gateAutomatedJournalEntry` has no POSTED branch —
  `src/lib/approval.service.ts:112`). No confidence score can auto-post.
- Two import **doors** (WhatsApp `.zip`, DevServer batch) converge on the **same** DRAFT
  → review → POST diligence.

---

## 1. Backlog context (so this doc ages well)

From Linear, BookLets project, 2026-07-29:

| State | Issues | Meaning |
|---|---|---|
| **Urgent / open** | **RAJ-719** | Corrected architecture facts (DevServer real; stale docs cost a session) — standing doc-fix tracker |
| **No priority / open** | **RAJ-725** | OCR architecture reference (filed this session) |
| **High / Todo** | **RAJ-687** | Ingest resilience re-arch: zip ghost-DRAFT, OCR off-platform fallback, sandbox dedup key |
| **High / Done** | RAJ-686 | Google sign-in fix (production) |
| **Done** | RAJ-242→264 | P0-01..06 (Vercel/Supabase/CI/Env/Indexes/Fiscal trigger) + P1-01..14 (hierarchy, idempotency, 4-eyes, RLS, reports) + P1-T1..T3 tests |
| **Done** | RAJ-265→273 | P2-01..07 (owner statements, portal, period-close, reconciliation, review dashboard) |
| **Canceled** | RAJ-274→388 | P3 backlog (multi-currency, tax, QB import, Sentry, load tests) — parked |

**Read:** phase 0/1/2 *engine* (4-eyes, RLS, idempotency, fiscal triggers, trial balance)
is **built**. What blocks *safe reuse* is RAJ-719 (doc truth), RAJ-687 (ingest
resilience — the zip ghost-DRAFT bug), and confirming prod wiring.

---

## 2. Pre-reuse gates (before flipping BookLets back on)

**RECOMMEND → CONSEQUENCE → BENEFIT**

- **R:** Merge `docs/runtime-service-map-handover` → `main`, close RAJ-719/RAJ-725.
  **C:** the "stale doc" trap can't recur. **B:** future sessions start from truth.
- **R:** Resolve RAJ-687 (zip ghost-DRAFT + sandbox dedup key) *before* a real WhatsApp
  zip hits prod. **C:** today a failed upload can leave phantom DRAFT rows. **B:** first
  real import won't corrupt the ledger.
- **R:** Confirm in Vercel (Production) that `OCR_BRIDGE_ORG_ID` + `SYMBIOS_API_KEY` are
  set. **C:** if unset, the offline DevServer→ledger path is inert (503) and live OCR has
  no fallback. **B:** you know whether the DevServer's 476 receipts can even reach books.
- **R:** Verify prod Supabase has HR-5 baseline (`idempotencyKey` column) + HR-6
  `raj_fin_track` SELECT grant. **C:** ocr-bridge throws without them. **B:** bridge runs
  first try.

---

## 3. The Sandbox / Staging area

### 3.1 What it is
The "sandbox" is **not a separate table** — it is the set of `JournalEntry` rows with
`status = 'DRAFT'` sitting in the *same* ledger table, quarantined by status so they don't
touch Trial Balance / P&L / Balance Sheet. (`JournalStatus.DRAFT` — `src/lib/types.ts:4`;
`status String @default("DRAFT")` — `prisma/schema.prisma:151`.)

### 3.2 Entry point — the WhatsApp zip
`POST /api/ingest/zip` (`src/app/api/ingest/zip/route.ts`). Takes a WhatsApp
finance/petty-cash export **.zip** (chat text + receipt images). Org comes from the
signed-in session (`resolveActiveContext`) — **never** client input. Accepts multipart
`file` or raw `application/zip`.

### 3.3 Guards (run BEFORE any OCR spend)
All guards execute inside `ingestZip` *before* OCR is paid for:
- `INVALID_ZIP` → 400, `TOO_MANY_ENTRIES` → 422, `TOTAL_SIZE_EXCEEDED` → 413,
  `PATH_TRAVERSAL` → 422, `ZIP_BOMB` → 422 (`zip/route.ts:27-33`).
- Hard **4.5 MB** body cap (`MAX_ZIP_UPLOAD_BYTES`), enforced twice — declared
  `content-length` check *and* a streaming `withByteCap` TransformStream that aborts the
  body the moment cumulative bytes exceed the cap, *before* `formData()` buffers it
  (`zip/route.ts:43-59, 74-115`). Closes the spoofed-Content-Length memory-exhaustion gap.
- Log injection neutralised: rejected codes `encodeURIComponent`-d before logging
  (`zip/route.ts:129`).

### 3.4 What gets written
**Every** receipt / chat line becomes a `JournalEntry` with `status = DRAFT`
(`zip/route.ts:25`; enforced by `gateAutomatedJournalEntry` →
`{ status: DRAFT, requiresHumanReview: true }` — `approval.service.ts:105-119`). Nothing
is posted to the real ledger at upload time.

---

## 4. The Main Books / Posted Ledger

### 4.1 What it is
The "main books" = `JournalEntry` rows with `status = 'POSTED'` plus the reports derived
from them (Trial Balance, P&L, Balance Sheet, General Ledger).

### 4.2 What flows in
Only POSTED rows feed reports. The promotion `DRAFT → POSTED` happens **only** via an
explicit human decision:
- `resolveDraftJournalDecision(DRAFT, APPROVE) → POSTED`; `REJECT → VOIDED`
  (`approval.service.ts:126-136`), valid **only from DRAFT**.
- `assertNotSelfApproval(maker, approver)` — the maker **cannot** approve their own entry;
  identities normalised (case/whitespace) so `"Alice "` ≡ `"alice"`
  (`approval.service.ts:45-70`). Backed by a DB trigger (RAJ-259).
- On POST, an `EvidenceLog` row is written **in the same transaction**
  (`ledger.service.ts:292`) — hash-chained audit trail per org.

### 4.3 Immutability
POSTED entries **cannot be deleted** (DB trigger RAJ-261). Reversals are recorded as new
entries + EvidenceLog, never destructive edits. Posting to a **closed fiscal period** is
blocked at DB level (trigger RAJ-247 / `P0-06`).

---

## 5. Functionality of each (side-by-side)

| | Sandbox (DRAFT) | Main Books (POSTED) |
|---|---|---|
| **Storage** | `JournalEntry` table, `status='DRAFT'` | Same table, `status='POSTED'` |
| **Feeds reports?** | No | Yes (TB / P&L / BS / GL) |
| **Who writes it** | Automation / import (OCR, zip, bridge) | Human 4-eyes approval only |
| **Editable** | Yes (review/correct) | Immutable (reverse only) |
| **Audit** | Pending review | EvidenceLog chained on post |
| **Exit** | → POSTED (approve) or VOIDED (reject) | Locked to closed periods |

---

## 6. Diligence: moving numbers sandbox → main books

| # | Step | Control (code-verified) | Diligence purpose |
|---|------|--------------------------|-------------------|
| 1 | **Upload** | zip route guards (size / bomb / traversal) run *before* OCR | stop malicious or corrupt input at the door |
| 2 | **Stage** | OCR → **DRAFT only** (`gateAutomatedJournalEntry`, no POSTED branch) | automation never touches real numbers |
| 3 | **Review** | human opens Receipt Review dashboard (RAJ-273 Done), sees receipt image **side-by-side** with proposed entry | human checks the AI didn't misread ₹ vs vendor |
| 4 | **Approve** | `resolveDraftJournalDecision` + `assertNotSelfApproval` (distinct reviewer) | **4-eyes** — no self-sign-off |
| 5 | **Post** | `postEntry` → `POSTED` + `EvidenceLog` write, idempotent via `idempotencyKey` | immutable, auditable, no duplicate on replay |
| 6 | **Lock** | fiscal-period trigger blocks posting to closed periods | period integrity |

**Idempotency:** `postEntryWithOutcome` checks `idempotencyKey` (or `source`+`sourceId`)
up front and on `P2002` conflict, counting replays/race-losers as `skipped_existing`,
never as new posts (`ledger.service.ts:219-347`).

---

## 7. The offline door (DevServer) reuses identical diligence

The DevServer (Hermes VPS `178.105.138.138`) is an **offline batch producer**, not a live
backend the app calls. Its `ocr-pipeline-*.py` writes results into the
`raj_fin_track.ocr_receipts` staging table; BookLets *reads* it via
`POST /api/ingest/ocr-bridge` (`src/app/api/ingest/ocr-bridge/route.ts`), which imports
eligible rows as **DRAFT** JournalEntries and runs them through the *same* review → POST
path. Bridge specifics: admin-only (OWNER/ADMIN), scoped to one org by `OCR_BRIDGE_ORG_ID`
(fails 503 if unset), idempotent, parked rows (OCR_FAILED / BAD_AMOUNT / NO_DOC_DATE /
FX_UNSUPPORTED / NO_FISCAL_PERIOD) excluded so the re-invoke loop terminates
(`ocr-bridge.deps.ts`).

**Key correction:** prior docs claimed "DevServer does not exist." It does — it's a core
Hermes fleet node (Firecrawl :3002, Ollama :11434). It is simply not a BookLets runtime
dependency; BookLets only consumes its OCR *output*.

---

## 8. References (file:line)

- Zip ingest: `src/app/api/ingest/zip/route.ts:13-33, 43-59, 74-139`
- DRAFT gate: `src/lib/approval.service.ts:105-119`
- 4-eyes: `src/lib/approval.service.ts:45-70, 126-136`
- Post + EvidenceLog + idempotency: `src/lib/ledger.service.ts:176-347`
- Status enum / default: `src/lib/types.ts:4-5`, `prisma/schema.prisma:151`
- Offline bridge: `src/app/api/ingest/ocr-bridge/route.ts`, `src/lib/ocr-bridge.deps.ts`
- Tracking: Linear RAJ-719, RAJ-725, RAJ-687

---

*Compiled 2026-07-29. Code-verified on `main`. Companion to
`docs/RUNTIME-SERVICE-MAP.md` and `docs/ARCHITECTURE-OCR-PIPELINE.md`. Mirrored to the
second-brain Obsidian vault as `BOOKLETS-SANDBOX-LEDGER-FLOW.md`.*

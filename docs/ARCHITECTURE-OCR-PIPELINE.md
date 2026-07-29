# BookLets — OCR / Receipt-Ingestion Architecture (core capability)

> **Scope.** This document is the **canonical architecture reference for ONE core
> capability** — receipt OCR and how extracted data reaches the ledger. It is the
> deep-dive companion to `docs/RUNTIME-SERVICE-MAP.md` (the broad external-service
> register). Where they disagree, fix the code and update both.
>
> **Provenance.** Compiled 2026-07-29 from a full code scan of `src/`, `scripts/`,
> `.env.example` on `main`. Every claim cites `file:line`. Companion Linear issue:
> **RAJ-7xx OCR architecture reference** (see Linear — link to this file).
>
> **One-sentence summary.** BookLets has **two disjoint OCR topologies**: a *live,
> interactive* path (gamma microservice → SymbiOS fallback) used by the app at
> runtime, and an *offline, batch* path (Hermes **DevServer** → `raj_fin_track`
> staging → `ocr-bridge` route) that the app only *reads from*. **The DevServer is
> NOT a live OCR backend the app calls** — it is an offline producer whose output is
> later promoted into the ledger.

---

## 1. Capability overview

"Receipt OCR" in BookLets means: take a receipt image/PDF, extract
`{vendorName, date, totalAmount, categorySuggestion, confidence}`, and turn it into a
**DRAFT** journal entry (never auto-POSTED). Two entry routes exist, with completely
different upstreams and transport:

| Topology | Trigger | OCR engine(s) | Transport into BookLets | Code entry point |
|----------|---------|---------------|------------------------|------------------|
| **Live interactive** | web/mobile upload, WhatsApp `.zip` import | gamma microservice (primary) → SymbiOS (fallback) | direct API call at ingest time | `extractReceipt()` in `src/lib/gemini-ocr.ts` |
| **Offline batch** | admin re-runs DevServer pipeline over a receipt folder | DevServer's `ocr-pipeline-*.py` (OpenRouter/Gemini) | writes `raj_fin_track.ocr_receipts`; app reads via `/api/ingest/ocr-bridge` | `src/app/api/ingest/ocr-bridge/route.ts` |

---

## 2. Topology A — Live interactive OCR (the path the app *calls*)

Single chokepoint: `extractReceipt()` (`src/lib/gemini-ocr.ts:40`).

```
receipt image (base64)
   └─ extractReceipt()                         (gemini-ocr.ts:40)
        ├─ (1) POST {OCR_MICROSERVICE_URL}/ocr   → gamma (default:
        │        https://ocr-microservice-gamma.vercel.app, gemini-ocr.ts:14)
        └─ (2) on failure → fallbackToSymbios()  (gemini-ocr.ts:104)
             └─ POST {SYMBIOS_URL}/api/v1/automation/extract-receipt
                  └─ throws if SYMBIOS_API_KEY unset
```

- `extractReceipt` is the **only** OCR call site. Consumed by:
  - `AutomationService.processReceipt` (`automation.service.ts:51`)
  - WhatsApp/zip ingest (`zip-ingest.deps.ts:12`)
- **DRAFT-only:** extracted receipts become DRAFT `JournalEntry` rows; human 4-eyes
  approval promotes DRAFT → POSTED. Never auto-posted.
- **Failure is safe:** if both engines fail, the receipt is recorded as an ingest
  *failure* (`stage:'ocr'`) — never silently mis-booked.

### 2.1 Defect — SymbiOS default mismatch (real, code-level)

`gemini-ocr.ts` and `automation.service.ts` define **two different SymbiOS defaults**
for the *same* env var:

| File | Line | Default when `SYMBIOS_URL` unset |
|------|------|----------------------------------|
| `src/lib/gemini-ocr.ts` | `:107` | `https://api.symbios.ai` |
| `src/lib/automation.service.ts` | `:18` | `http://localhost:8080` |

`automation.service.ts` *also* has its own second SymbiOS fallback at `:64`
(its `this.SYMBIOS_URL` constant). When `SYMBIOS_URL` is unset, the two OCR fallback
paths target **different hosts**. **Fix:** set `SYMBIOS_URL` explicitly in prod, and
align `automation.service.ts:18` to the canonical `https://api.symbios.ai` (or always
route through `gemini-ocr.ts`).

---

## 3. Topology B — Offline batch OCR (the path the app only *reads*)

```
DevServer (Hermes VPS, 178.105.138.138)
   ocr-pipeline-v3.py / ocr-pipeline-v4-openrouter.py
   (idempotent; retry/backoff; 476 receipts in /root/kolake-data/receipts)
        │  writes OCR results
        ▼
   raj_fin_track.ocr_receipts   (Supabase schema — SEPARATE from BookLets' `booklets`)
        │  read-only from BookLets app
        ▼
   POST /api/ingest/ocr-bridge  (src/app/api/ingest/ocr-bridge/route.ts)
        │  runOcrBridgeImport(orgId, batchSize)
        ▼
   DRAFT JournalEntry rows  (promoted to POSTED via 4-eyes review)
```

- **The app never calls the DevServer.** The DevServer writes to Supabase; BookLets
  reads that Supabase staging table. The DevServer is reached only by *Hermes/SSH* for
  pipeline runs, not by the BookLets runtime.
- `ocr-bridge` is **admin-only** (OWNER/ADMIN role, `route.ts:17,44`) and **scoped to
  one org** via `OCR_BRIDGE_ORG_ID` (`route.ts:53-65`). It **fails closed (HTTP 503)**
  when `OCR_BRIDGE_ORG_ID` is unset — so this path is **dormant by default**.
- Idempotent: re-invoke until `remaining === 0`; deterministically-parked rows
  (OCR_FAILED / BAD_AMOUNT / NO_DOC_DATE / FX_UNSUPPORTED / NO_FISCAL_PERIOD) are
  excluded so the loop terminates (`route.ts:28-31`).

---

## 4. ⚠️ The critical clarification — DevServer is an OFFLINE PRODUCER, not a live backend

This is the most-misunderstood fact about BookLets' OCR:

- BookLets' **live** OCR at runtime = gamma microservice (+ SymbiOS fallback). See §2.
- The DevServer is a **Hermes fleet node** (Hostinger VPS) that Hermes uses for its own
  batch work — receipt OCR, **self-hosted Firecrawl** (`:3002`), **Ollama** (`:11434`),
  and the KolaC photo pipeline. It is **not** something the BookLets app invokes.
- BookLets' only connection to DevServer-produced data is the **read-only**
  `raj_fin_track.ocr_receipts` table, pulled in via `ocr-bridge` (§3).
- It is *possible* (but not wired) to make the DevServer a live backend: stand up a
  `POST /ocr` endpoint on it and set `OCR_MICROSERVICE_URL=<devserver-url>` in the
  `booklets` Vercel project. The DevServer today runs batch `ocr-pipeline` scripts, not
  an `/ocr` HTTP service, so this is **not** the current path.

**Why this matters:** prior docs (PR #100 `RUNTIME-SERVICE-MAP.md`) wrongly claimed
"DevServer does not exist — all-repo search 2026-07-19." A repo search cannot find a
VPS. The DevServer absolutely exists and is heavily used by Hermes; its BookLets role
is the offline receipt-OCR producer feeding `raj_fin_track`. See `RUNTIME-SERVICE-MAP.md §4b`.

---

## 5. Governance invariants (apply to both topologies)

- **DRAFT-only on automation.** No receipt is ever auto-POSTED; 4-eyes review promotes
  DRAFT → POSTED. Enforced in `approval.service.ts` (`gateAutomatedJournalEntry`).
- **Evidence chain.** Every ledger post writes an `EvidenceLog` row (hash-chained per
  org) inside the same transaction (`LedgerService.postEntry`).
- **Parked states.** Unparseable/failed receipts are parked (not dropped) with a reason
  code; visible in the sandbox/review queue.
- **No raw `fetch()` in services.** All external HTTP goes through
  `fetchWithTimeout`/`fetchWithRetry` (`src/lib/http.ts`).

---

## 6. Config / env registry (OCR-relevant)

| Var | Set? | Secret | Notes |
|-----|------|--------|-------|
| `OCR_MICROSERVICE_URL` | ❌ | no | → gamma default (`gemini-ocr.ts:14`). Live path primary. |
| `OCR_TIMEOUT_MS` | ❌ | no | default 15 000 ms (`gemini-ocr.ts:15-19`). |
| `SYMBIOS_URL` | ❌ | no | **set explicitly** — removes the §2.1 mismatch. |
| `SYMBIOS_API_KEY` | ❌ (key) | yes | fallback unconfigured → live OCR stalls if gamma down. |
| `OCR_BRIDGE_ORG_ID` | ❌ | no | offline path fails closed (503) until set. |
| `DATABASE_URL` | ✅ | yes | `raj_fin_track` is a **separate** Supabase schema the app reads. |

> **Prod-config caveat (honest):** `.env` / `.env.prod` are **gitignored**, so the
> *actual* Vercel production values of `OCR_BRIDGE_ORG_ID` / `SYMBIOS_API_KEY` cannot be
> confirmed from this repo. The code path is **fails-closed by design** — if
> `OCR_BRIDGE_ORG_ID` is unset in Vercel, the offline bridge returns 503 and is inert.
> Verify live status in the Vercel dashboard (`booklets` project, Production scope), not
> from the repo.

---

## 7. Open gaps / defects

1. **SymbiOS default mismatch** (`gemini-ocr.ts:107` vs `automation.service.ts:18`) — real code defect; fix in §2.1.
2. **Offline bridge dormant by default** — `OCR_BRIDGE_ORG_ID` unset → 503. Intentional fails-closed, but means DevServer-produced OCR is *not* reaching the ledger until configured.
3. **Single-homed live OCR** — gamma has no fallback URL; if gamma is down *and* `SYMBIOS_API_KEY` unset, live receipts stall at `stage:'ocr'`.
4. **Model-drift (external, unverified in this repo):** RAJ-719 reports the gamma microservice hardcodes `gemini-3.5-flash` while the DevServer pipeline hardcodes `gemini-2.5-flash`. Those files live outside this repo (gamma = `~/GitHub/ocr-microservice`; DevServer = VPS scripts), so this is **not** code-verified here — treat as a tracking item, not a confirmed fact.
5. **Stale docstring** — `gemini-ocr.ts:5,9` says default `localhost:3099`; actual default is the gamma URL (`:14`).

---

## 8. References (file:line)

- Live OCR: `src/lib/gemini-ocr.ts:14,40,104,107`
- Automation consumer: `src/lib/automation.service.ts:18,51,64`
- Ingest consumer: `src/lib/zip-ingest.deps.ts:12`
- Offline bridge route: `src/app/api/ingest/ocr-bridge/route.ts:25,53`
- Bridge deps (read-only staging): `src/lib/ocr-bridge.deps.ts:5,19`
- External register + fleet node: `docs/RUNTIME-SERVICE-MAP.md §4 (#1,#3,#7), §4b`
- Tracking: Linear RAJ-719 (corrected architecture facts); this capability doc linked from Linear.

---

*Compiled 2026-07-29. Code-verified on `main` unless marked external. Companion to
`docs/RUNTIME-SERVICE-MAP.md`.*

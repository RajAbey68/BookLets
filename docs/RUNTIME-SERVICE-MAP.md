# BookLets — As-Built Runtime & External Service Map (Handover)

> **Purpose.** Single source of truth for every *external* service, microservice, and
> integration BookLets depends on, plus where it is wired in code. This is the
> **as-built** reality, verified by reading the source on `main` (2026-07-29), so
> any agent or session works from the same truth.
>
> **Provenance.** Compiled from a full repo code scan (`grep` over `src/`, `scripts/`,
> `.env.example`) on 2026-07-29. Every endpoint/env var below cites a file:line.
> Authoritative tracking issue: **Linear RAJ-719** (Urgent, Backlog) — its doc-fix
> checklist for this file was open; this file closes it.
>
> **Companion.** If a design canon `ARCHITECTURE.md` exists, this doc is the as-built
> counterpoint to it. (Note: as of 2026-07-29 neither `ARCHITECTURE.md` nor this file
> is present on `main` — both live only on unmerged branches. That gap is tracked in
> §9 below.)

---

## 1. Deployment topology

| Item | Value |
|------|-------|
| Canonical URL | **https://booklets.vercel.app** |
| Source | GitHub `RajAbey68/BookLets`, default branch `main` (protected) |
| Deploy trigger | push to `main` → Vercel production build → alias to canonical URL |
| Local repo (this machine) | `/Users/arajiv/BookLets` (git, origin = `RajAbey68/BookLets`, branch `main`) |

## 2. Data layer (system of record)

| Item | Value |
|------|-------|
| Supabase project ref | `euqdfxekrxnoibeahogq` (eu-west-1) |
| App schema | `booklets` (Prisma sets `search_path=booklets,public`) |
| Connection | `DATABASE_URL` — pooled (6543) via PgBouncer (`src/lib/prisma.ts:77`, `.env.example:11`) |
| Tenancy | single-tenant (DB-trigger enforced) |

## 3. Auth (Auth.js / NextAuth v5 — Google OAuth only)

| Env var | Used at | Notes |
|---------|---------|-------|
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | `src/auth.config.ts:21-22` | Google OAuth client |
| `AUTH_ALLOWED_EMAILS` | `src/auth.ts:34` | **Fail-closed** allow-list — empty in prod rejects all |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | `src/proxy.ts:38` | session secret; missing → 500 on every request |

---

## 4. External service dependency register ⚠️ read if you own one of these

| # | Service | Role | Prod-effective endpoint | Env override | Auth | Wired in code (file:line) | Prod status (2026-07-29) |
|---|---------|------|-------------------------|--------------|------|---------------------------|---------------------------|
| 1 | **OCR microservice (gamma)** | receipt OCR — **primary** | `https://ocr-microservice-gamma.vercel.app/ocr` | `OCR_MICROSERVICE_URL` | none observed | `src/lib/gemini-ocr.ts:14` (default), called by `automation.service.ts:51`, `zip-ingest.deps.ts:12` | Hardcoded default = **LIVE**. `OCR_MICROSERVICE_URL` unset → gamma used. |
| 2 | **SymbiOS** | receipt OCR — **fallback** | `https://api.symbios.ai/api/v1/automation/extract-receipt` | `SYMBIOS_URL` | `SYMBIOS_API_KEY` | `src/lib/gemini-ocr.ts:107-108` (fallback path); also `src/lib/automation.service.ts:18,64` | `SYMBIOS_API_KEY` **unset** in `.env.example` → if gamma down, OCR stalls at `stage:'ocr'` (no silent mis-book). |
| 3 | **DevServer** (`hermes-gateway`, Hostinger VPS) | bulk / offline receipt OCR worker + `raj_fin_track` staging source; **also a general Hermes fleet node** (self-hosted Firecrawl, Ollama, file/photo batch processing) | `178.105.138.138` (`ssh devserver`) | — | SSH key | App code only references it obliquely (`src/lib/ocr-bridge.ts:15` "re-OCR is devserver work, not ours"; optional OCR backend via `OCR_MICROSERVICE_URL`). **It is NOT a BookLets app dependency — it is a first-class node in the Hermes agent fleet** (see §4b). | **EXISTS & LIVE** — SSH-verified 2026-07-29: up 29 days, host `hermes-gateway`. Holds `/root/kolake-data/receipts` (476 receipts) + idempotent OCR pipelines (`ocr-pipeline-v3.py`, `ocr-pipeline-v4-openrouter.py`). Listens on `127.0.0.1:11434` (Ollama). Hermes routes Firecrawl scraping via `FIRECRAWL_API_URL=http://178.105.138.138:3002`. |
| 4 | **Hostaway** | PMS booking sync | `https://api.hostaway.com/v1` (+ `/v1/access-tokens`) | `HOSTAWAY_CLIENT_ID/SECRET/API_KEY`, `HOSTAWAY_ACCOUNT_ID`, `STRICT_HOSTAWAY` | client/secret | `src/lib/hostaway.service.ts:23,114`; consumed by `revenue.service.ts` | **LIVE data** — revert any test bookings. |
| 5 | **Google OAuth** | sign-in | `accounts.google.com` | — | `AUTH_GOOGLE_*` | `src/auth.config.ts` | configured |
| 6 | **Supabase Postgres** | system of record | project `euqdfxekrxnoibeahogq` | `DATABASE_URL` | conn string | `src/lib/prisma.ts:77` | live |
| 7 | **raj_fin_track.ocr_receipts** | OCR staging (S1b bridge, read-only) | Supabase schema | `OCR_BRIDGE_ORG_ID` | DB | `src/app/api/ingest/ocr-bridge/route.ts:53` | read-only bridge; route fails closed (503) while `OCR_BRIDGE_ORG_ID` unset |
| 8 | **Ko Lake BI cube** | read-only analytics feed | configurable Supabase (schema `scrap`, table `cube_bi`) | `NEXT_PUBLIC_KOLAKE_SUPABASE_URL`, `NEXT_PUBLIC_KOLAKE_SUPABASE_ANON_KEY` | anon key (read-only) | `src/lib/kolake-cube.ts:149-168` | Degrades to "not configured" empty state if env missing. **Separate** from BookLets' Prisma DB. |

---

## 4b. Hermes agent fleet nodes (the DevServer is one of these — NOT just a BookLets concept)

The DevServer is **not** a BookLets application dependency; it is a **first-class node in
the Hermes agent fleet** that Hermes itself uses extensively (per the operator SOUL.md
standing rule: *"Maintain a live prioritised queue so no Always-Up node ever sits idle
(Hostinger devserver, hermes-dev…)"*). BookLets only touches it indirectly (the
`raj_fin_track` OCR output it produces, bridged via `OCR_BRIDGE_ORG_ID`).

Verified live 2026-07-29 via SSH (SSH config hostnames `devserver` / `hermes-dev`):

| Node | IP | Provider | Role / services observed | Status |
|------|----|----------|--------------------------|--------|
| **DevServer** (`hermes-gateway`) | `178.105.138.138` | Hostinger | Receipt OCR pipeline (476 receipts in `/root/kolake-data/receipts`; `ocr-pipeline-v3.py`, `ocr-pipeline-v4-openrouter.py`); **self-hosted Firecrawl** at `:3002` (`FIRECRAWL_API_URL=http://178.105.138.138:3002`, used by Hermes for web scraping); **Ollama** at `127.0.0.1:11434`; general batch/file processing. | **LIVE** — up 29 d, 2 vCPU / 3.8 GB, no GPU, CPU idle (API-bound). |
| **hermes-dev** | `167.233.236.178` | Hetzner | KolaC photo enhancement batch (8 vCPU, multiprocessing), BRISQUE/quality gate, `rawpy`/`libraw` RAW→TIFF conversion, Drive write-back. | **LIVE** — up 24 d. |

**Key correction to earlier docs:** the prior `RUNTIME-SERVICE-MAP.md` (PR #100) claimed
*"DevServer does not exist — all-repo search 2026-07-19."* A repo search cannot find a
VPS — that conclusion was wrong. The DevServer absolutely exists and is heavily used by
Hermes itself (Firecrawl, Ollama, OCR, photo pipeline), not merely as a BookLets backend.
Its role in BookLets is the **offline receipt-OCR worker** feeding `raj_fin_track`, which
`/api/ingest/ocr-bridge` promotes into the ledger.

---

## 5. OCR routing detail (the part that actually breaks)

Single OCR entry point is `extractReceipt()` in `src/lib/gemini-ocr.ts`:

```
imageBase64
  └─ extractReceipt()                      (gemini-ocr.ts:40)
       ├─ (1) POST {OCR_MICROSERVICE_URL}/ocr   → gamma default (live)
       └─ (2) on failure → fallbackToSymbios()  (gemini-ocr.ts:104)
            └─ POST {SYMBIOS_URL}/api/v1/automation/extract-receipt
                 └─ throws if SYMBIOS_API_KEY unset
```

`extractReceipt` is the **only** OCR call site used by both
`AutomationService.processReceipt` (`automation.service.ts:51`) and the WhatsApp/zip
ingest path (`zip-ingest.deps.ts:12`). Note `automation.service.ts` *also* has a
second, independent SymbiOS fallback at `:64` (its own `SYMBIOS_URL` constant) — see
drift #1 below.

## 6. Ko Lake cube integration

`src/lib/kolake-cube.ts` (RAJ-649) reads `scrap.cube_bi` from a **separate** Supabase
project via `@supabase/supabase-js` with a read-only anon key. Gated behind two env
vars; pure helpers (`applyCubeQuery`, `cubeRowsToCsv`, …) are unit-testable without a
live connection. This is analytics only — it never writes to BookLets' ledger.

---

## 7. Config / env registry (production)

| Var | Set? | Secret | Notes |
|-----|------|--------|-------|
| `DATABASE_URL` | ✅ | yes | Supabase pooled |
| `AUTH_SECRET` / `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` / `AUTH_ALLOWED_EMAILS` | ✅ | mixed | auth |
| `HOSTAWAY_*` | per Vercel | mixed | PMS sync |
| `OCR_MICROSERVICE_URL` / `OCR_TIMEOUT_MS` | ❌ | no | → gamma default / 15 000 ms |
| `SYMBIOS_URL` / `SYMBIOS_API_KEY` | ❌ (key) | key=yes | fallback unconfigured |
| `OCR_BRIDGE_ORG_ID` | ❌ | no | staging bridge fails closed |
| `NEXT_PUBLIC_KOLAKE_SUPABASE_URL` / `_ANON_KEY` | ❌ | no | analytics degrades gracefully |
| `EXTERNAL_FETCH_TIMEOUT_MS` | ❌ | no | default 30 000 ms (`src/lib/http.ts:2`) |

---

## 8. Ingestion API surface (session-auth'd)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/ingest/item` | POST | primary — one WhatsApp export entry → DRAFT entry / chat evidence |
| `/api/ingest/batch` | POST | closes one import run; writes server-recounted summary |
| `/api/ingest/zip` | POST | legacy whole-`.zip` → DRAFT (small archives only; 4.5 MB body cap on Vercel) |
| `/api/ingest/ocr-bridge` | POST | `raj_fin_track.ocr_receipts` staging → DRAFT |
| `/api/export/{ledger,trial-balance,pl,balance-sheet}` | GET | report exports |
| `/api/health` | GET | liveness (public) |

---

## 9. Drift / corrections against prior docs (P1 — zero fabrication)

These are the facts that were previously **wrong** in the unmerged
`docs/RUNTIME-SERVICE-MAP.md` (PR #100) and in some docstrings. Corrected here:

1. **DevServer EXISTS (and is a core Hermes fleet node).** Prior doc claimed
   "DevServer does not exist — all-repo search 2026-07-19." A repo search cannot find a
   VPS. SSH-verified live 2026-07-29: `178.105.138.138` (`hermes-gateway`), up 29 days,
   holds the 476 receipts + idempotent OCR pipeline, and runs self-hosted **Firecrawl**
   (`:3002`) and **Ollama** (`:11434`). It is a first-class node in the Hermes agent
   fleet — Hermes uses it extensively for its own work (scraping, OCR, photo pipeline),
   not merely as a BookLets backend. Its BookLets-facing role is the offline receipt-OCR
   worker producing `raj_fin_track`, promoted into the ledger by `/api/ingest/ocr-bridge`.
   (See §4b.)
2. **SymbiOS default mismatch (real code defect).** `gemini-ocr.ts:107` defaults
   `SYMBIOS_URL` to `https://api.symbios.ai`, but `automation.service.ts:18` defaults
   its *own* `SYMBIOS_URL` to `http://localhost:8080`. Same env var, two hardcoded
   fallbacks. When `SYMBIOS_URL` is unset, the two OCR fallback paths target **different
   hosts**. Set `SYMBIOS_URL` explicitly in prod to remove the ambiguity.
3. **Stale docstring.** `gemini-ocr.ts:5,9` says default `http://localhost:3099`; the
   actual default (`gemini-ocr.ts:14`) is the gamma URL. Docstring is wrong.
4. **This file was absent from `main`.** `docs/RUNTIME-SERVICE-MAP.md` (PR #100,
   `9fae4e1`) and its DevServer correction (`7f29f2e`, branch
   `fix/smoke-assertion-and-devserver-doc`) exist only on **unmerged branches** — not
   on `main`. This handover commits the corrected version to `main`.
5. **`ARCHITECTURE.md` also missing on `main`.** The canon companion referenced by this
   doc is not present on `main` either. Create or restore it to complete the design set.

## 10. Handover checklist / open gaps

- [x] External service register documented from code (this file).
- [x] DevServer existence + endpoint recorded (corrects RAJ-719 §1).
- [ ] **Set `SYMBIOS_URL` + `SYMBIOS_API_KEY` in prod** — removes single-homed OCR gap
      (gamma down ⇒ receipts stall). Options: set SymbiOS key, or deploy a 2nd OCR
      instance + `OCR_MICROSERVICE_FALLBACK_URL`.
- [ ] Fix SymbiOS default mismatch in `automation.service.ts:18` (align to
      `api.symbios.ai` or always rely on `gemini-ocr.ts` path).
- [ ] Fix stale docstring in `gemini-ocr.ts:5,9`.
- [ ] Restore `ARCHITECTURE.md` to `main` (design canon).
- [ ] Add CI guard failing if `docs/RUNTIME-SERVICE-MAP.md` is missing on `main` (prevents
      silent re-drift).
- [ ] Close RAJ-719 doc-fix checklist item once this file is merged.

## 11. Guardrails (constrain every change here)

DRAFT-only automation · four-eyes (CODEOWNERS on money-path + non-Anthropic model review
+ deterministic CI floor) · TDD first · Stripe sandbox-only · backup-before-migrate ·
never commit to `main` directly.

---

*Compiled 2026-07-29. Verified against `main` source. Tracking: Linear RAJ-719 (Urgent).*

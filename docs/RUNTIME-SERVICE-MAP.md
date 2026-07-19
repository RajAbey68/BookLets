# BookLets — As-Built Runtime & Service Map

> **Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md).** That file is the
> gate-approved *target design* (ingest library, `booklets_staging` schema,
> promotion function, lockstep). **This file is the *as-built* reality** — what
> is actually deployed, wired, and configured in production — so every service
> we call (OCR microservice, DevServer, SymbiOS) and every agent works from the
> same truth. Where the two disagree, that gap is tracked in §8.
>
> **Verified against production `2026-07-19`.** Deployed SHA `7a8fc3b`.
> Canonical URL **https://booklets-one.vercel.app**. Owner: `RajAbey68`.
> Update this file in the same PR as any topology / service / config change.

---

## 1. Deployment topology

| Item | Value |
|------|-------|
| Canonical URL | **https://booklets-one.vercel.app** |
| Vercel project | `booklets` (team `team_IkwKtIFAHXEsmnUhIlW3Mse9`) |
| Deploy trigger | push to `main` → Vercel production build → aliased to canonical URL |
| Do-not-use alias | `booklets-rajabey68s-projects.vercel.app` (behind Vercel login wall — breaks OAuth) |
| Source | GitHub `RajAbey68/BookLets`, default branch `main` (protected) |

## 2. Data layer

| Item | Value |
|------|-------|
| Supabase project ref | `euqdfxekrxnoibeahogq` (eu-west-1) |
| App schema | `booklets` (Prisma pins `search_path=booklets,public`) |
| Connections | app: pooled (6543) · backups/migrations: **direct** (5432) — see `docs/BACKUP-RESTORE.md` |
| Tenancy | single-tenant, DB-trigger enforced (`enforce_single_tenant`) |

**Write-time invariants live in Postgres** (raw-SQL migrations, applied by `psql` per `DEPLOY.md §4` — *not* auto-run by Vercel):
`20260703_fiscal_lock_and_posted_delete_triggers` · `20260712_rls_org_isolation` · `20260716_single_tenant_lock`.
RLS is *enabled*; **FORCE RLS is a separate DBA step** (needed before a 2nd tenant).

## 3. AuthN / AuthZ

Auth.js / NextAuth v5, **Google OAuth only**, JWT sessions; route-gating in `src/proxy.ts`.

- Public routes: `/login`, `/api/health`, `/api/auth/*`. All else → `/login`.
- Allow-list `AUTH_ALLOWED_EMAILS` (`src/auth.ts`) is **fail-closed** — empty in prod rejects everyone.
- Google client `116263110764-…apps.googleusercontent.com` (GCP `leadsync-489921`); authorised redirect URI must include `https://booklets-one.vercel.app/api/auth/callback/google`.
- Failure modes: wrong `NEXTAUTH_URL` → `redirect_uri_mismatch`; empty allow-list → `AccessDenied`.

## 4. API surface (what BookLets exposes)

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/health` | GET | public | liveness |
| `/api/auth/[...nextauth]` | * | public | NextAuth OAuth |
| `/api/ingest/zip` | POST | session | **S5** WhatsApp `.zip` → DRAFT entries |
| `/api/ingest/ocr-bridge` | POST | session | **S1b** `raj_fin_track.ocr_receipts` staging → DRAFT |
| `/api/export/{ledger,trial-balance,pl,balance-sheet}` | GET | session | report exports |

## 5. Ingestion flow (as-built)

```
WhatsApp .zip ─POST /api/ingest/zip─► ingestZip()
 (_chat.txt+images)                    ├─ guards: path-traversal, zip-bomb, entry-cap,
                                       │   type-allowlist, 100 MB cap  (BEFORE any OCR spend)
                                       ├─ per image: extractReceipt(b64) ─► OCR microservice ─(fallback)─► SymbiOS
                                       ├─ dedup: sha256(image bytes) per org  (+ DB unique constraint)
                                       └─ LedgerService.postEntry(DRAFT)   debit Suspense 9999 / credit Cash 1000
                                                │
                                          /review ─ human four-eyes ─► POSTED
```
- **DRAFT-only**: `gateAutomatedJournalEntry` forces DRAFT regardless of OCR confidence (auto-POST abolished — canon §4).
- UI entry point: dashboard **"Import WhatsApp export (.zip)"** (`WhatsappZipUploader.tsx`, shipped PR #99).

## 6. External service dependency register  ⚠️ **read if you own one of these**

| Service | Role | Prod-effective endpoint | Env override | Auth | Prod status 2026-07-19 |
|---------|------|-------------------------|--------------|------|------------------------|
| **OCR microservice** | receipt OCR (primary) | `https://ocr-microservice-gamma.vercel.app/ocr` | `OCR_MICROSERVICE_URL` | none observed | **UNSET → hardcoded default; default is LIVE** (`POST /ocr` empty → 400) |
| **SymbiOS** | receipt OCR (fallback) | `https://api.symbios.ai/api/v1/automation/extract-receipt` | `SYMBIOS_URL` | `SYMBIOS_API_KEY` | **key UNSET → fallback throws if primary down** |
| **DevServer** (Hermes-built) | intended OCR host? | — | `OCR_MICROSERVICE_URL` | — | **NOT WIRED — no env points here** (§8.1) |
| **Hostaway** | PMS bookings sync | `https://api.hostaway.com/v1` | `HOSTAWAY_ACCOUNT_ID`, `STRICT_HOSTAWAY` | `HOSTAWAY_CLIENT_ID/SECRET`, `HOSTAWAY_API_KEY` | ⚠️ **LIVE data — revert test bookings** |
| **Google OAuth** | sign-in | `accounts.google.com` | — | `AUTH_GOOGLE_ID/SECRET` | configured |
| **Supabase Postgres** | system of record | project `euqdfxekrxnoibeahogq` | `DATABASE_URL` | conn string | live |
| **`raj_fin_track.ocr_receipts`** | OCR staging (read-only source, S1b) | Supabase schema | `OCR_BRIDGE_ORG_ID` | DB | read-only bridge |

### OCR client contract — any OCR host (incl. DevServer) must conform
`extractReceipt(imageBase64)` → `POST {OCR_MICROSERVICE_URL}/ocr`
- **Request:** `{"imageBase64":"<base64, no data-URI prefix>","mode":"receipt"}`, JSON, aborts after `OCR_TIMEOUT_MS` (default **15000 ms**).
- **Response 200:** `{"extraction":{vendorName,date(ISO-8601|""),totalAmount(number),categorySuggestion,confidence(0–1)}}`.
- **Non-200 / unreachable:** BookLets falls back to SymbiOS; no key → image recorded as ingest **failure** (`stage:'ocr'`), never silently mis-booked.

**To make DevServer the OCR backend:** implement `POST /ocr` (above) and set
`OCR_MICROSERVICE_URL=<devserver-url>` on the `booklets` Vercel project (production), then redeploy.

## 7. Config / env registry (production, verified 2026-07-19)

| Var | Set | Secret | Note |
|-----|-----|--------|------|
| `NEXTAUTH_URL` | ✅ | no | canonical URL |
| `AUTH_SECRET` / `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | ✅ | yes | auth |
| `AUTH_ALLOWED_EMAILS` | ✅ | no | fail-closed allow-list |
| `DATABASE_URL` | ✅ | yes | Supabase pooled |
| `OCR_MICROSERVICE_URL` / `OCR_TIMEOUT_MS` | ❌ | no | → gamma default / 15 000 ms |
| `SYMBIOS_URL` / `SYMBIOS_API_KEY` | ❌ | key=yes | fallback unconfigured |
| `HOSTAWAY_*` / `OCR_BRIDGE_ORG_ID` | see Vercel | mixed | PMS / bridge |

## 8. OPEN GAPS — resolve, do not assume (P1 zero-fabrication)

1. **DevServer identity & wiring.** Owner states an OCR host "DevServer" was built by Hermes; BookLets does **not** call it (`OCR_MICROSERVICE_URL` unset → routes to gamma). Either DevServer *is* the gamma service under a nickname (confirm), or set `OCR_MICROSERVICE_URL` to DevServer's URL + redeploy. **DevServer's address is unknown to this repo.**
2. **OCR single-homed.** No `SYMBIOS_API_KEY` → no working fallback if primary OCR is down.
3. **Design-vs-as-built drift** (this doc vs the canon):
   - Canon §4 specifies a separate `booklets_staging` schema; **as-built** stages as **DRAFT `JournalEntry` rows in the `booklets` schema** (debit Suspense 9999 / credit Cash 1000). The dedicated staging schema is *not yet built*.
   - Canon §6 requires **FORCE RLS on both schemas + DB write-role separation**; as-built has RLS enabled but **FORCE not applied** and no separate `staging_writer`/`ledger_writer` roles yet.
   - Canon §5 specifies an atomic `promote_staging_to_ledger()` DB function; as-built promotion is the app-side DRAFT→POSTED review flow.
4. **Stale docstring** in `gemini-ocr.ts` (says default `localhost:3099`; actual default is the gamma URL).

## 9. Guardrails (constrain every change here)

DRAFT-only automation · four-eyes (CODEOWNERS on money-path + non-Anthropic model review + deterministic CI floor) · TDD first · Stripe sandbox-only · backup-before-migrate.

---
*Created 2026-07-19 (sign-in fix + WhatsApp-upload build, PR #99). Companion to the design canon `ARCHITECTURE.md`.*

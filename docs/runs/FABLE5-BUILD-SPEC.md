# BookLets Go-Live — Autonomous Build Spec for Claude (Fable 5)

> **PASTE THIS WHOLE FILE INTO FABLE 5 AS THE MISSION.**
> Fable 5 is the **thinking orchestrator** — it reasons, plans, decomposes, and
> verifies. It does **NOT** burn its own tokens on grunt toil (file edits, test
> runs, OCR loops, DB inserts). It **delegates toil to cheap, efficient sub-agents**
> and to **Hermes** (the local orchestration agent) where Hermes already owns
> the running infra (dev server, DB, OCR pipeline). Token economy is a hard rule, not a hint.

---

## 0.1 INFRASTRUCTURE & SURFACES (self-contained — do NOT look these up; they are authoritative)

### Machines (SSH, all root, StrictHostKeyChecking=no)
| Name | Host | Use |
|---|---|---|
| **devserver** | `178.105.138.138` (hostname `hermes-gateway`) | PRIMARY build/runtime host. Has `~/BookLets` (canonical repo), `~/kolake-data/` (`receipts/` = 476 staged receipt files, `_chat.txt`, Wise CSVs, `csv2-kolake.csv`), `~/kolake_originals_backup/` (30 files). OCR pipeline scripts in `/root/BookLets/scripts/`. |
| **hermes-dev** | `167.233.236.178` | Secondary. Has `~/AutumnHarvest`, `~/LeadSynch`, `~/dashboard`, `file-upload`, `start-services.sh`. Use only if devserver is down. |

Dev server paths of record:
- `/root/BookLets/` — the BookLets repo (canonical `github.com/RajAbey68/BookLets.git`, branch `main`).
- `/root/BookLets/scripts/` — `ocr-pipeline-v3.py` (writes to `raj_fin_track`), `gemini-batch-ocr.sh`, `gemini-ocr-v2.py`, `gemini-ocr-loader.js`, `kolake-sandbox-ocr.js`, `run-sandbox-loader.sh`, `.sandbox-env` (Gemini key), `.db-env` (**MISSING — defect D2**).
- `/root/kolake-data/receipts/` — 476 receipt images (the OCR input).
- `/tmp/gemini-results/` — 468 OCR result JSONs (7 Jul run; **not yet loaded to DB**).
- `/root/BookLets/scripts/run-sandbox-loader.sh` — **cron Mon 06:00** (the standing weekly load job).

### Local Mac surfaces (Raj's machine — Hermes terminal GATES all writes/mutations)
- **Repos:** `~/GitHub/BookLets` (working copy), `~/GitHub/BookLets-wt-kolake-recon` (recon pilot worktree, branch `feat/kolake-reconciliation-pilot`), `~/GitHub/WhatHappen` (zip pre-loader reference: `app/api/process-file/route.ts`), `~/GitHub/ocr-microservice` (prod OCR microservice: `src/gemini-ocr.ts`, `gemini-3.5-flash`), `~/GitHub/AiInteg` (`scripts/linear_helper.py`).
- **Staging (this work):** `~/second-brain/staging/kolake-finance/` — `BOOKLETS-GO-LIVE-PLAN.md`, `FABLE5-BUILD-SPEC.md`, `SESSION-STATE-2026-07-12.md`, `create-booklets-linear.sh`, `receipt-load-manifest.csv`, `non-receipt-artifacts.csv`, `devserver-ocr-results/` (468 JSONs), `shadow-storage/` (517 unzipped files).
- **Obsidian vault:** `~/Documents/Obsidian Vault/` (git-backed, flat, wikilinks; hub `Projects-Overview.md`). Has `BookLets.md` (QBO review), `Ko-Lake-Villa.md`, `Projects-Overview.md`. **Read for context; do NOT treat as source of record for live data.**
- **second-brain:** `~/second-brain/` (CLAUDE.md = boot index; `memory/`, `context/`, `daily/`, `projects/`). The canonical second brain; Obsidian mirrors parts of it.
- **MCP tool IDs (Cowork, for Hermes sessions):** Gmail `mcp__287fa16a-…`, Calendar `mcp__5d781d23-…`, Drive `mcp__b169339b-…`, Supabase `mcp__449e2366-…` (project `euqdfxekrxnoibeahogq`), Vercel `mcp__09dc3da7-…`.

### Ollama (LOCAL model server — use for cheap local inference, NOT Fable's tokens)
Raj runs Ollama locally. Available models (as of 2026-07-10/12):
- `nomic-embed-text:latest` (274 MB) — **embeddings only**.
- `qwen3-coder:30b` (18 GB) — **local coding agent** (good for grunt code edits / test runs off-Fable).
- `gemma3:12b` (8.1 GB), `llama3.2:3b` (2.0 GB), `hermes3:latest` / `hermes3:8b` (4.7 GB) — local chat/reasoning.
**Use:** spawn `qwen3-coder:30b` (or `hermes3:8b`) via Ollama for low-cost Builder toil where a frontier API isn't required. Fable 5 reasons; Ollama does local grunt.

### Keychain (macOS — authoritative secrets; never commit)
| Service | Holds | Notes |
|---|---|---|
| `gemini-api` | Google Gemini API key (`AIzaSy…`) | Used by `ocr-microservice` + dev-server OCR. `security find-generic-password -s gemini-api -w`. |
| `Linear API Key` | Linear GraphQL key | **NOT in keychain currently** — `create-booklets-linear.sh` reads it; if absent, Raj adds it. Helper `~/GitHub/AiInteg/scripts/linear_helper.py` (TEAM_ID `e53b9f72-c372-4bf6-bfe4-8dd343900f90`, DONE state `b2f061dc-077c-451a-a997-faa51e68aa06`). |
| `symbios` / `deepseek` | (none present) | If needed later, Raj provisions; not required for this spec. |

### Supabase (runtime DB)
- Project `euqdfxekrxnoibeahogq` (EU-west-1). Schema **`raj_fin_track`**. Pooler URL form: `postgresql://postgres.<ref>@<region>.pooler.supabase.com:5432/postgres?sslmode=require`.
- **RLS mandatory on every table** (constraint). Service role must NOT bypass org isolation.
- BookLets connects via `prisma.config.ts` (`DATABASE_URL` — Prisma 7 dropped `datasource.url` from schema).

### Vercel (deploy)
- Framework `nextjs`; `buildCommand npm run build`, `installCommand npm ci` (`vercel.json`).
- Prod URL `booklets.vercel.app` **currently 500** (defect D1 — env/DB). No custom domain yet (RAJ-277 pending).

### Node
- **Use nvm v22** (`nvm use 22`) — NOT Homebrew v25 (non-LTS). Dev server/node versions: v22.23.1 confirmed locally.

---

## 0.2 KNOWLEDGE SURFACE — everything Fable 5 may LEARN FROM (read before deciding; authoritative, do NOT re-derive from chat)

### Boot (Raj's standing rule — run first)
- **`bash ~/.hermes/profiles/rajabey68/scripts/boot-orient.sh`** — deterministic live probe (keychain, ssh fleet, gcloud, second-brain docs, priorities). **Trust its output over any static value in any doc.** It cannot rot (queries reality). GLM-5.2 + Qwen, 2026-07-12.

### Second brains (redundant stores — cross-check, don't trust one)
| Path | What it holds | Use for this spec |
|---|---|---|
| **`~/second-brain/`** (canonical) | `CLAUDE.md` boot index; `memory/` (user_rajiv, reference_tools, reference_repo_catalog, project_*); `context/` (priorities, agent-secrets-registry, gcp-always-on-host, agent-platform-architecture, llm-cost-architecture, business-es); `projects/` (41-repo portfolio-registry.json/.md, ko-lake-villa, symbios, ai-integrity, leadsync, build-infrastructure, autumn-harvest, ghostwriter-engine, digital-law-firm, platform-max); `architecture/`; `coordination/`; `checkpoints/`; `runbooks/`; `daily/`; `team/`; `knowledge/` (quality-standards, author-voices); `scripts/`; `skills/`. | **Primary source.** Registry tells you every repo's stack/deploy/CodeQL status before you touch it. |
| **`~/Documents/Obsidian Vault/`** (git-backed, flat, wikilinks) | `Projects-Overview.md` hub; `BookLets.md` (QBO review); `Ko-Lake-Villa.md`; `AI-Notes-Template.md`; `Knowledge-Query-Template.md`. | Context only — NOT live data of record. |
| **`~/Library/Mobile Documents/com~apple~CloudDocs/Second Brain/`** (iCloud, Hermes-facing) | Mirror of second-brain: `CLAUDE.md` nav, `context/`, `intelligence/`, `team/`, `resources/`, `skills/`. | Cross-check when starting Hermes sessions; wins on conflict only for Hermes-facing facts. |
| **`~/.hermes/SOUL.md`** | Boot orientation index into second-brain + keychain + fleet + Linear. | If amnesiac, this is the root-cause fix — keep it current. |

### Portfolio registry (MUST consult before touching any repo)
- **`~/second-brain/projects/portfolio-registry.json`** (machine-readable) + **`.md`** (human).
- 41 GitHub repos catalogued: description, live URL, stack, deploy status, CodeQL status, category, relationships.
- BookLets entry: `github.com/RajAbey68/BookLets`, Next.js16/Prisma7/Supabase/Vercel, deploy PENDING (500), CodeQL status per registry.
- Symbios, WhatHappen, ocr-microservice, BookLets-wt-kolake-recon all cross-referenced here.

### Fleet / compute (where work runs)
- **Always-on hosts:** `devserver` (178.105.138.138), `hermes-dev` (167.233.236.178), plus GCP + a spare old Mac per operating model (zero-idle queue — no Always-Up node idles).
- **Compute tiering (Raj rule):** owned-first → serverless-GPU (flag) → on-demand (cost-flag). Deliver utilisation + cost dashboard.
- `~/second-brain/context/gcp-always-on-host.md`, `agent-platform-architecture.md`, `llm-cost-architecture.md` — read before provisioning anything.

### Agentisation / architecture (how Raj runs agents)
- `~/second-brain/projects/claude-sessions/WhatToDo/project-agentisation-roadmap.md` — Linear-tracked agent plan.
- `project-agent-fleet-design.md`, `strangler-transitional-layer-design*.md` (v1–v3) — incremental migration pattern.
- `agent-briefs/`, `ai-colleague-agent.md`, `community-intelligence-agent.md` — agent role defs.
- **Operating model:** Linear = control plane. Four-eyes on every gate. Hermes advice default-FIRST; override only on CLAUDE.md P-rule conflict, then flag.

### Skills (reusable procedures — load before repeating a known task)
- `~/second-brain/skills/` + `~/.hermes/profiles/rajabey68/skills/`.
- Relevant here: `kolake-petty-cash-categorization` (mirrors the petty-cash policy doc — keep in sync), finance-doc-staging, requesting-code-review, test-driven-development, plan.
- Load a skill if a subtask matches; don't re-derive.

### Secrets registry (names + locations ONLY — never values in files/chat)
- `~/second-brain/context/agent-secrets-registry.md` + macOS keychain.
- Keychain services of record: `gemini-api` (present), `Linear API Key` (absent — Raj adds), `symbios`/`deepseek` (none).
- Zoho creds in `~/.env` (EU region); GoDaddy automation blocked (bot+2FA) — guide in Raj's browser, verify via `dig`.

### MCP tool IDs (Cowork — for Hermes sessions)
Gmail `mcp__287fa16a-…`, Calendar `mcp__5d781d23-…`, Drive `mcp__b169339b-…`, Supabase `mcp__449e2366-…` (project `euqdfxekrxnoibeahogq`), Vercel `mcp__09dc3da7-…`.

### Daily / decisions
- `~/second-brain/daily/YYYY-MM-DD.md` — daily logs; `intelligence/` (meetings, decisions) in iCloud vault. Read today's before starting; write one at session end.

---

## 0.3 EXISTING LOADERS / MICROSERVICES — REUSE, DON'T REBUILD

The fleet already has production loaders. **S1–S10 wrap or reuse these — they are NOT greenfield.** Each row: what it loads, where, and which S-service reuses it.

### Dev server (`ssh devserver`, /root/BookLets/scripts/)
| Loader | Loads | Reused by |
|---|---|---|
| `ocr-pipeline-v3.py` | OCR JSONs → `raj_fin_track` (idempotent, retry/backoff, Telegram notify) | **S1** (db-load) — run this after `.db-env` restored |
| `gemini-batch-ocr.sh` / `gemini-ocr-v2.py` | batch Gemini OCR (gemini-2.5-flash) | **S5** (zip-ingest) OCR step |
| `gemini-ocr-loader.js` / `kolake-sandbox-ocr.js` / `kolake-sandbox-ocr-loader.js` | sandbox OCR + bulk load | **S1/S5** alternative path; prefer `ocr-pipeline-v3.py` |
| `kolake-sandbox-bulk-loader.js` | bulk DRAFT load to raj_fin_track | **S5/S7/S8** bulk insert (reuse, don't re-code) |
| `run-sandbox-loader.sh` | **cron Mon 06:00** standing weekly load | **S5** schedule reference |
| `seed-ledger.ts` | seeds ledger | **S10** phantom-fix reference |
| `agent-bus-discover.sh` | service discovery (where work runs) | Fable orientation |
| `/root/kolake-data/receipts/` (476) + `/tmp/gemini-results/` (468 JSONs, 7 Jul) | source receipt payload | **S1** input |
| `/root/kolake_originals_backup/` (30 files) | original backup source | **S1** fallback |

### Local Mac repos
| Loader / microservice | Loads | Reused by |
|---|---|---|
| `~/GitHub/ocr-microservice` (`src/gemini-ocr.ts`, gemini-3.5-flash) | structured receipt OCR (vendor/date/amount/category) | **S5** OCR engine (shared, prod-grade) |
| `~/GitHub/WhatHappen` `app/api/process-file/route.ts` | **unzip + OCR + load** (adm-zip, caps ≤1000 entries/≤200MB, split text/images, 5-parallel OCR, zip-bomb guards) | **S5** zip-ingest reference — reuse its guards + split logic |
| `~/GitHub/BookLets` `scripts/test-hostaway-sync.ts`, `verify-hostaway.ts` | Hostaway sync + verify | **S9** historical Hostaway verification (sunset, §1.5) |
| `~/GitHub/BookLets-wt-kolake-recon` `feat/kolake-reconciliation-pilot` | revenue reconciliation (payouts↔bookings, DRAFT, LLM adjudication DeepSeek) | **S9** base — extend to EXPENSE side |
| `~/GitHub/AiInteg/scripts/linear_helper.py` | Linear ops | orchestration tracking |

### Input channels (not yet wired — flag for S-services)
- **Zoho Mail** (`mail.zoho.eu/api/organization/`, `scripts/zoho.sh`, `~/.env` EU) — receipts/statements may arrive by email → potential **S5/S7/S8** input channel.
- **Google Drive** (`~/Library/CloudStorage/GoogleDrive-rajabey68/My Drive/KoLake Files/`) — accountant PDFs/statements → potential **S7 (CF3)** source (MCP Drive ID in §0.1).
- **WhatsApp export** (zip) — current primary S5 input (the 517-file zip).

**Rule:** before coding any loader, check this table + the repo's existing scripts. Reuse first; only build when nothing exists.

---

## 0. ROLE MODEL — who does what (token-efficiency first)

| Role | Model | Does | Does NOT |
|---|---|---|---|
| **Fable 5 (you)** | Anthropic — *synthesis/thinking only* (CLAUDE.md P-1) | Plan, decompose, assign contracts, read checkpoint verdicts, make go/no-go calls, write the adversarial briefs | Edit files, run test suites, hit the DB, loop OCR. **Delegate all of it.** |
| **Builder sub-agents** | Frontier coding (Codex 6.5 / Grok 4.5) — cheap per-call | The actual code edits, migrations, test code, PRs | Review their own work (P-3) |
| **Checker / Verifier / Adversarial reviewer** | **NON-Anthropic only** — DeepSeek v4-flash / Gemini Flash / GLM-5.2 (CLAUDE.md P-1) | Pass/block every checkpoint; sign `checkerIdentity` | Be Anthropic; self-approve |
| **Hermes** | Local orchestration agent (already owns your infra) | Anything needing the dev server / Supabase / OCR pipeline / Linear script that's already stood up | Re-derive context Fable can hand it |

**Branching rule (§2.7 D-B, hard):** one `main` line. Each service = a short-lived branch off `main` → draft PR → 4-eyes (Layer 1 + Layer 2) → **rebase-merge** (never merge commits; never per-service long-lived release branches). Parallel *agents* per wave, serial *integration* to main. Fable orchestrates agents, not branches.
**Economy rules:**
- Fable 5 writes **contracts + briefs**, not diffs. A milestone that needs 40 file edits = one Builder agent spawned with the contract, **not** Fable editing 40 files.
- Use **Hermes** (or a tiny low-token agent) for: running the dev-server OCR loader, re-running `create-booklets-linear.sh`, any `ssh devserver` work, polling. These are Hermes's lanes — don't spend Fable tokens re-doing them.
- **Low-token agents for grunt:** test execution, lint, build, curl health-checks, count queries — spawn a minimal agent or use Hermes; never Fable's context.
- At every checkpoint, **Fable receives a compact report** (checkpoint format below), reasons about it, and either delegates the fix or advances the wave.

---

## 1. MISSION (the goal — not the steps)

Make BookLets **live on Vercel** and able to **ingest new financial inputs autonomously**:
1. WhatsApp finance/petty-cash **zips** (unzip → OCR → DB, in-app).
2. **CF3 bank statements** (money in AND out).
3. **Wise** CSV (outflows AND revenue-in).
4. Hostaway revenue — already seeded in PMS tables; **do not rebuild**, only reconcile against it.
Then **reconcile** Wise/bank outflows ↔ petty-cash receipts with VerReq flagging and
four-eyes verification, categorised per the USALI petty-cash policy.

**Done =** BookLets serving (200 OK), a real zip ingested end-to-end into `raj_fin_track`,
a CF3 statement imported, and a May/June reconciliation produced — **each proven with
tool output, not description.**

---

## 1.5 DATA-SOURCE AUTHORITY (resolves revenue-in conflict)

- **Wise = system of record for ALL money movement** — outflows AND revenue-in.
  M6 (wise-import) is the **authoritative** revenue-in source. New revenue flows
  through Wise, not Hostaway.
- **Hostaway = SUNSET.** `RevenueService` (Hostaway sync, B-01) is on a
  **decommission plan** — legacy/transition only. Do NOT treat it as a peer
  revenue source. **No new revenue should enter via Hostaway.** During transition,
  reconcile Hostaway's *already-seeded* rows as historical; the live path is Wise.
- **Consequence for reconciliation (S9):** reconcile **Wise** outflows AND Wise
  revenue-in against receipts/payouts. Hostaway is **out of the core path** (historical
  only). This removes the double-count risk — there is no Wise-vs-Hostaway peer
  reconciliation; Wise is single-source.
- **Migration note:** as Hostaway sunsets, any residual Hostaway revenue not yet in
  Wise should be **back-filled into Wise (M6)**, not kept as a parallel source.

---

## 2.6 DEFINITIONS (read before any work — resolve ambiguity, don't invent)

- **JournalStatus lifecycle** (schema enum): `DRAFT` (OCR'd/imported, unverified, editable) → `POSTED` (four-eyes-verified, immutable) → `VOIDED` (reversed via new entry, never deleted). Confidence <1.0 = stays DRAFT; only human+Checker sign flips to POSTED.
- **VerReq** (verification-required): a Wise/bank transfer with NO matching receipt in the petty-cash group. Lifecycle (from `petty-cash-accounting-policy.md` §3): *Unverified → Matched-Unverified (system match) → Matched-Verified (named 2nd-person sign-off) / VerReq (no evidence) / Unallocated (evidence, no transfer)*. **Nothing POSTED while its VerReq is open.**
- **Matched / Matched-Unverified / Matched-Verified / Unallocated** — reconciliation states for S9.
- **Maker / Checker** — see §5. Maker builds; Checker (non-Anthropic) gates.
- **Service (in this spec)** — a BookLets capability with a typed contract (in→out), implemented behind the 5 existing services (§CONTEXT), exposed via a route/server-action, DB writes only through Ledger/Revenue/Automation/EvidenceLog/Metrics. NOT a separate deployable; lives in the BookLets repo.
- **CF3** — the bank statement format Raj uses. **Dialect to confirm at S7:** ISO 20022 `camt.053` (bank-to-cust) unless the file header says otherwise; LKR variant. S7 MUST print the parsed control total and tie to the source ±0.01 before posting. If the dialect is unrecognised, HALT (do not guess schema).
- **Closed period** — a fiscal period locked by a DB trigger; no POSTED entries may be added to it (FRD A-07). May/June 2026 MUST be closed after reconciliation.
- **idempotencyKey** — a unique key on `JournalEntry` (FRD A-08) so re-runs/retries never double-post. Required for all importers (S5/S7/S8).
- **Checkpoint (🛑)** — a mandatory stop where Fable emits the §7 report; Layer-1 Checker + Layer-2 Hermes must sign before proceeding.

## 2.7 DECISIONS (locked — Raj + Hermes, not Fable)

| # | Decision | Value | Rationale |
|---|---|---|---|
| D-A | **S5 ingest target** | **A — live DRAFT** (ingest real 517-file zip into `raj_fin_track` as DRAFT). NOT sandbox-first. | DRAFT is non-destructive by policy (§2.6); four-eyes blocks POSTED. Safer than a parallel schema + promote step, and the data is needed now. |
| D-B | **Branching model** | **One main line. Parallel *agents* per wave, each a short-lived branch off `main` → PR → 4-eyes → rebase-merge. NO per-service release branches.** | Monorepo + shared schema; parallel long-lived branches = merge-hell at migration layer. Parallel execution, serial integration. (See §0 Role branching rule.) |
| D-C | **Revenue-in source** | **Wise (system of record). Hostaway = sunset.** | §1.5. |
| D-D | **Currency** | **Book entries in LKR** (Wise/CF3/receipts are LKR). Base currency = LKR for Ko Lake books; EUR only if a non-LK entity emerges. FX at transaction date (FRD B-07). | Avoids fictitious "trial balance = 0" across currencies. |
| D-E | **Reviewer models** | Builder = frontier (Codex/Grok). Checker/4-eyes = non-Anthropic (DeepSeek/Gemini/GLM). Fable = Anthropic thinking only. | P-1. |
| D-F | **Go-live trigger** | **Raj (Layer 3) only**, at 🛑 Z, after Layer-2 PASS. | No autonomous prod flip. |

---

## 2.8 TOKEN & CADENCE GUARDS (prevents "burn a whole session, test only at the end")

These exist BECAUSE a long autonomous loop with no stop can exhaust tokens before
Raj gets anything testable. They are hard rules, not suggestions.

- **G1 — Fable is a thinking orchestrator, not a toil-runner (§0).** Fable never
  edits files / runs tests / hits the DB. Builders (frontier/non-Anthropic) + Hermes
  do the grunt. Fable's own token spend is short bursts between waves — an
  "hour of Fable tokens" must not happen.
- **G2 — Hard TOKEN budget per run: ~12M output tokens total** (proxy for the $100
  cross-vendor cap; see §2.9 E4 — Fable cannot meter cross-vendor dollars, enforces
  tokens hard). **Halt + write bus + ask Raj the moment estimated tokens reach ~12M**
  (or projected to exceed within current wave). Never silently spend past it. On halt:
  STOP all agents, report merged vs pending, resume from last merged wave (G7) once
  Raj raises the cap. Fable emits a running token estimate to the bus at EVERY wave
  boundary (G4). A token spike usually means a model was mis-assigned → auto-investigate.
- **G3 — Raj tests EARLY, not at Z.** First testable slice = **after Wave 0**
  (S1 real data in DB + S2 app 200 + S4 conf gate). Raj may **pause after ANY
  🛑 checkpoint to manually test**; Fable HOLDS, does not auto-advance past a
  pause. So the worst case is "test after 1–2 services," not "test at service 12."
- **G4 — Surface to Raj at EVERY wave boundary**, not just Z. After each wave,
  Fable writes the bus (§6.5) AND flags Raj (Layer 3) for a look. Raj can redirect
  mid-loop. The bus is live-readable without a full paste-back.
- **G5 — Cheap models for grind (§2.7 D-E).** Builders = frontier/non-Anthropic;
  Checker = non-Anthropic; Fable (Anthropic) = thinking only. This is the single
  biggest token-saver and is mandatory (P-1).
- **G6 — No checkpoint skipped.** Every 🛑 in §8 must emit + get Layer-1 + Layer-2
  sign-off. Skipping a checkpoint to "save time" = auto-BLOCK (it's where drift
  hides).
- **G7 — Recoverable state.** All progress is in git (PRs) + the bus file. If the
  run halts (budget/error/pause), Raj resumes from the last merged wave — no
  lost work, no re-run-from-zero.

---

## 2. HARD CONSTRAINTS (violation = auto-BLOCK at any checkpoint)

- **P-1 budget:** Fable/Anthropic = BUILD/synthesis/thinking only. Every checker/verifier/reviewer = **non-Anthropic** (DeepSeek/Gemini/GLM). **Never spawn an Anthropic sub-reviewer.** (Builder sub-agents MAY be frontier/non-Anthropic coding models — they are build, not review.)
- **P-0 Stripe:** sandbox only — N/A here; never touch live payment paths.
- **P-1 sources:** no fabricated figures/outputs. Real tool output or raise a gap.
- **P-3 four-eyes:** maker ≠ checker. Machine never self-promotes to Verified/POSTED. The Checker agent's signed identity is the gate.
- **P-4 TDD:** failing test FIRST, then code. Repo has NO tests today (D6) — establish vitest.
- **RLS on ALL Supabase tables.** Never write DB directly — go through the 5 services (Ledger/Revenue/Automation/EvidenceLog/Metrics).
- **Money = Decimal(19,4)/decimal.js.** Never round-trip through JS number.
- **Confidence <1.0 → DRAFT, never auto-POST** (fixes defect D3).
- Branch off main; draft PR on push; rebase not merge; claim scope in AGENTS_LOG.md.

---

## 2.5 METHODOLOGY — B-MAD + 4-EYES CODING (governs every milestone)

### B-MAD (plan before code — phases, not just steps)
Fable 5 runs the **B-MAD lifecycle** per milestone; do NOT skip to code:
1. **Analyst** — state the requirement + acceptance criteria (the checkpoint verdict IS the acceptance test).
2. **PM** — scope the service contract (§4 in/out), list dependencies (wave order), flag out-of-scope.
3. **Architect** — name the files/tables/migrations touched; confirm RLS/money/4-eyes constraints apply.
4. **PO** — sequence the sub-tasks; set the TDD order (RED→GREEN→REFACTOR).
5. **Scrum Master** — dispatch Builder sub-agents per wave; collect checkpoint reports.
6. **Dev** — Builder implements behind contract (TDD).
7. **QA** — the **Checker agent** (non-Anthropic) runs the checkpoint; **BLOCK returns to Dev, never to the Builder who wrote it** (4-eyes: maker ≠ checker).
Every artifact versioned in git. Quality gates honoured before PASS.

### 4-EYES CODING (the review gate — reviewer's §weakness #2, now enforced)
- **Two distinct identities on every merge:** `makerIdentity` (Builder/Fable) ≠ `checkerIdentity` (non-Anthropic Checker). Recorded in `EvidenceLog` per the briefing's `EvidenceLogInput` shape.
- **Checker verifies REALITY, not Fable's report.** Before issuing PASS, the Checker agent MUST:
  - re-run ≥1 command itself (or read the raw PR diff / live endpoint), and
  - confirm the claimed evidence matches reality (e.g. actually `curl` the health URL, actually `SELECT count(*)` the table).
  A PASS backed only by Fable's summary = **VOID** (auto-BLOCK).
- **Self-review forbidden.** A Builder (Anthropic or frontier) may not review its own PR. The Checker is always the distinct non-Anthropic agent.
- **Four-eyes sign-off is the merge key.** No service proceeds past 🛑 without a recorded `PASS` + `checkerIdentity`. The maker's own "done" counts as nothing.
- **Tiered reviewers (CLAUDE.md P-5 / ISACA):** for schema/ledger/money changes, the Checker applies the stricter bar (Dr=Cr, Decimal(19,4), RLS present). Matcher/categorisation changes get a domain Checker against `petty-cash-accounting-policy.md`.

---

## 2.9 ENVIRONMENT & EXECUTION MODEL (corrects launch blockers — READ FIRST)

Fable 5 runs in a **remote cloud container, not Raj's Mac**. The following are
corrected from earlier sections so the loop actually works:

- **E1 — Spec + bus live in GIT, not a Mac path.** The spec is pasted inline into
  Fable's session (not read from `~/second-brain/...`). The run log (`FABLE5-RUN-LOG.md`)
  lives in the **BookLets repo** at `docs/runs/FABLE5-RUN-LOG.md` and is committed +
  pushed regularly (satisfies G7 recoverability + bus persistence). Fable writes it
  there, not to Raj's local disk.
- **E2 — TWO distinct targets. Do NOT conflate them:**
  - **CODE target = `rajabey68/booklets` repo** (Fable's session can edit code here).
    S1–S12 *app code* EXTENDS existing BookLets machinery: `src/lib/ledger.service.ts`
    (idempotency + fiscal-period locks + posted-delete triggers), `gemini-ocr.ts`,
    `hostaway.service.ts`, `docs/AGENT_BUS.md` + `.agent-bus.json`.
  - **RUNTIME/DATA target = `devserver` (178.105.138.138, root)** — NOT Fable's
    container, NOT the repo. This is where the finance pipeline lives: `~/kolake-data/receipts`
    (476), `/tmp/gemini-results/` (468 OCR JSONs, 7 Jul), `ocr-pipeline-v3.py`,
    `.sandbox-env` (Gemini key), and the missing `.db-env` (D2). **The actual DB load,
    zip ingest, and OCR execution happen HERE, on the dev server.**
  - **BookLets ≠ "kolake-finance" as one codebase.** BookLets is the app; the finance
    data + pipeline are on devserver. Do NOT assume they are the same repo or that
    Fable's repo session contains the finance data. They do not.
- **E6 — EXECUTION BOUNDARY (critical):** Fable (cloud) **NEVER SSHes to devserver,
  NEVER runs the OCR pipeline, NEVER touches the live DB directly.** Any 🛑 step
  requiring devserver / OCR / DB = Fable EMITS a request (what to do + expected
  evidence); **Hermes (Raj's local agent, who owns the dev-server relationship)
  executes it** and returns the real tool output. Fable then records Hermes's
  evidence in the checkpoint — it does not fabricate or self-run. This is the
  original design: Fable thinks; Hermes operates the server. If a checkpoint cannot
  proceed without devserver access, Fable HALTS and flags Raj; Hermes runs it.
- **E3 — All spawned agents are Claude (Anthropic).** Fable CANNOT dispatch to
  GPT/Gemini/non-Anthropic models. Therefore:
  - "Non-Anthropic Builder" (§0/G1) → **reinterpreted**: Builders are Claude agents;
    the *token-economy* intent (Fable thinks, agents toil) still holds.
  - **Layer-1 (Checker) + Layer-2 (Hermes judge) COLLAPSE into the external review
    loop**: Fable emits the §7 checkpoint report → Raj pastes it to **Hermes** →
    Hermes gives PASS / JUDGE-BLOCK → Raj pastes verdict back to Fable. Fable does
    NOT self-accept and does NOT wait for an in-session non-Anthropic checker.
  - **P-1 caveat:** since Builders are Anthropic, the strict "checkers non-Anthropic"
    rule cannot be met inside this session. The mitigation is the **external Hermes
    review** (distinct model, Raj-mediated) — accepted as the four-eyes equivalent
    here. Flag this limitation in the bus.
- **E4 — Budget is TOKENS, not dollars.** Restate G2: halt at **~12M output tokens**
  total (proxy for the $100 cross-vendor cap; Fable enforces token ceiling hard,
  cannot meter cross-vendor $). Emit running token estimate at every wave boundary.
- **E5 — Repo reality (absorb Fable's findings):** before Wave 0, RECONCILE doc drift:
  - `docs/BRIEFING_FOR_OTHER_SERVICES.md` wrongly says "no tests" — repo has **24
    Vitest suites**. Use the real count.
  - `ROADMAP.md` lists merged items as backlog — trust git history, not ROADMAP.
  - **SoD incomplete (D5 confirmed live):** P1.4 CI gate disabled
    (`.github/workflows/p1-governance.yml:39`); `makerIdentity` hardcoded to
    `'booklets-automation-service'`. **S2/S3/S8 must fix this** — real session user
    in `makerIdentity`, re-enable P1.4.
  - **RLS enabled but NO policies** + `public`/`booklets` schema mismatch via
    `search_path` (Message.md). **S3 (rls-lock) is critical** — add real policies,
    resolve schema mismatch.
  - **Multi-tenant stopgap:** app picks oldest property (context.actions.ts:19);
    user-scoped picker is follow-up — note, don't block.
  - **SymbiOS integrity layer** (ORM-level trial-balance/fiscal-lock/audit) — ledger
    work must play nice with it; don't bypass.
  - **CI is strict** (typecheck, zero-warning lint, coverage ratchet, npm audit,
    CodeQL, P0/P1 workflows) — Builders must clear all to merge `main`.

---

## 3. CONTEXT (self-contained — hand this to every sub-agent)

- Repo `/Users/arajiv/GitHub/BookLets` (main). Recon worktree `/Users/arajiv/BookLets-wt-kolake-recon` (feat/kolake-reconciliation-pilot) = REVENUE side only; extend for EXPENSE. Stack: Next.js16, Prisma7 (@prisma/adapter-pg), Supabase schema `raj_fin_track` (EU-west-1), Vercel.
- **Dev server:** `ssh devserver` (178.105.138.138 root). `~/kolake-data/receipts` (476), OCR pipeline `ocr-pipeline-v3.py` → `raj_fin_track`. Gemini `gemini-2.5-flash` (single model). Key in `~/BookLets/scripts/.sandbox-env`. Weekly cron Mon 06:00.
- **DEFECT D2:** `/root/BookLets/scripts/.db-env` MISSING → 468 OCR JSONs (7 Jul, in devserver `/tmp/gemini-results`, copied to `~/second-brain/staging/kolake-finance/devserver-ocr-results/`) never loaded to DB.
- **Zip pre-loader reference impl:** WhatHappen `app/api/process-file/route.ts` (adm-zip, caps ≤1000 entries/≤200MB, split text/images, OCR cap 5 parallel).
- **Business rules:** `docs/business-rules/petty-cash-accounting-policy.md` (USALI 5 cats: F&B/Housekeeping/Maintenance/Utilities/Opex-Transport; VerReq lifecycle; mandatory cash log; nothing posts while VerReq open).
- **Not live:** `booklets.vercel.app` returns 500.
- **Linear:** keychain item `Linear API Key`; script `~/second-brain/staging/kolake-finance/create-booklets-linear.sh` (run in Raj's own Terminal.app — Hermes terminal gates API POSTs).

---

## 4. SERVICE CATALOGUE (the milestones ARE micro-services)

Each service = a contract + an owner-agent. Fable orchestrates; builders implement behind contracts.

| # | Service | Contract (in → out) | Owner-agent | Depends on |
|---|---|---|---|---|
| S1 | **db-load** (M1) | restore `.db-env` → 468 OCR JSONs landed in `raj_fin_track` (idempotent) | Builder (frontier) | dev server |
| S2 | **deploy-fix** (M2) | env audit → `booklets.vercel.app` returns 200 | Builder | — |
| S3 | **rls-lock** (M3) | enumerate tables → RLS + org-isolation policy on ALL | Builder | — |
| S4 | **conf-gate** (M9) | TDD: conf>0.9 auto-POST → DRAFT<1.0 | Builder | — |
| S5 | **zip-ingest** (M4) | `POST /ingest/zip` → unzip→OCR→DRAFT rows | Builder | S1 |
| S6 | **review-ui** (M8) | DRAFT queue: image+entry side-by-side; batch approve→Checker signs | Builder | S5 |
| S7 | **cf3-import** (M5) | `POST /import/cf3` → journal lines (in+out), totals tie ±0.01 | Builder | LedgerService |
| S8 | **wise-import** (M6) | `POST /import/wise` → outflows + revenue-in (**Wise = system of record**, see §1.5) | Builder | LedgerService |
| S9 | **reconcile** (M7) | `POST /reconcile?period=` → Matched/VerReq/Unallocated — **Wise outflows AND Wise revenue-in** vs receipts (Hostaway = sunset, historical only, §1.5) | Builder | S5,S7,S8 |
| S10 | **phantom-fix** (D4) | manual booking → DR Cash/CR Guest Pre-payments posted | Builder | S2 |
| S11 | **idempotency-key** (FRD A-08) | add `idempotencyKey` to `JournalEntry` schema + enforce unique; importers (S5/S7/S8) stamp it on every entry | Builder | S4 |
| S12 | **closed-period** (FRD A-07) | DB trigger: lock closed fiscal periods; block POSTED into them; close May/June 2026 post-S9 | Builder | S3,S9 |

---

## 5. PERMANENT ROLES (four-eyes is architectural, not a note)

- **Maker** = Fable 5 + Builder sub-agents (frontier). Produce DRAFT / branch / PR.
- **Checker** = distinct **non-Anthropic** agent (DeepSeek/Gemini/GLM). Owns every 🛑 checkpoint verdict; signs `EvidenceLog.checkerIdentity`.
- **Hard gate (machine-enforced, not prose):** no service proceeds past 🛑 without a `PASS` from the Checker agent recorded against the PR. Self-approval = auto-BLOCK.

### Three-layer review model (who judges what)
1. **Layer 1 — Checker agent (non-Anthropic, P-1).** Per-checkpoint gate. Signs `PASS`/`BLOCK` against the PR. Machine-enforced; self-review void.
2. **Layer 2 — Hermes (Raj's trusted advisor / contrarian critical thinker).** **Hermes is the ACCEPTANCE-CRITERIA JUDGE.** Hermes reads the persistent bus (§6.5) and the Checker's verdicts, and makes the *final* acceptance call: does the work meet Raj's intent and the hard constraints, not just pass the mechanical gate? Hermes may BLOCK a Layer-1 PASS on contrarian grounds (scope-creep, budget breach, silent assumption, four-eyes theatre). Hermes' BLOCK overrides the Checker's PASS.
3. **Layer 3 — Raj (human).** Ultimate go/no-go; flips go-live at 🛑 Z.

- **Fable 5 does NOT self-accept.** It may advance a wave on Layer-1 PASS, but it must surface the bus to Hermes (Layer 2) before claiming any milestone "done." A checkpoint is only **ACCEPTED** when Layer 2 (Hermes) confirms — not when Layer 1 alone signs.
- **Hermes writes its acceptance verdict to the bus** (`FABLE5-RUN-LOG.md`, §6.5) with `judge: hermes` + rationale, so the call is auditable.

---

## 6. WAVE ORCHESTRATION (parallel, dependency-aware, token-cheap)

Fable spawns builders **per service**, in waves. ≤3 concurrent (Raj's max_concurrent_children).

- **Wave 0 (parallel):** S1 (db-load), S2 (deploy-fix), S4 (conf-gate — pure TDD)
- **Wave 1:** S3 (rls-lock) ∥ S5 (zip-ingest)
- **Wave 2 (after S5):** S6 (review-ui) + S7 (cf3) + S8 (wise) — **all three parallel**
- **Wave 3:** S9 (reconcile) — needs S5+S7+S8
- **Wave 4:** S10 (phantom-fix) — anytime after S2
- **Final:** 🛑 CHECKPOINT Z gate — after ALL waves PASS

Each wave's builders run concurrently; **Fable does not await linearly** — it dispatches, collects checkpoint reports, reasons.

---

## 6.5 PERSISTENT BUS — write to a file every step (early heads-up, reviewable)

Fable 5 and **every sub-agent** MUST keep a durable, human + reviewer-readable
log of all progress, decisions, and checkpoint outcomes. **Nothing lives only in
context.** This is the internal bus Raj reviews while the loop runs.

- **Bus file:** `~/second-brain/staging/kolake-finance/FABLE5-RUN-LOG.md`
  (create at loop start; append-only; Hermes/low-token agent can own the writes).
- **Write cadence (mandatory):**
  - **Every 🛑 CHECKPOINT** → append the full checkpoint report block (§7) + the
    Checker's `PASS`/`BLOCK` verdict + `checkerIdentity`.
  - **Every non-trivial decision** (wave dispatch, model chosen per agent, scope
    claim, drift-guard trigger) → 1–3 line entry with timestamp.
  - **Every delegated task** → record: agent spawned, model, contract handed, PR/branch.
  - **Every BLOCK** → record findings + the fix dispatched; record re-emit when done.
- **Format:** append, never overwrite. Timestamp each entry (`YYYY-MM-DD HH:MM`).
- **Reviewer (me) reads THIS file** to review between your paste-backs — I do
  not need the full checkpoint re-pasted; I read the bus.
- **Hermes owns the bus writes** where appropriate (per §0 token economy) —
  Fable reasons about *what* to log; a cheap agent appends it. Fable never
  spends tokens re-typing the log into chat.
- **If the bus file is missing/unwritable, HALT and report** — silent
  context-only progress is a failure mode (the amnesiac bug).

This file is the **single source of truth for "what did the loop do"** — above
any chat summary.

---

## 7. CHECKPOINT FORMAT (every 🛑 — emit verbatim AND append to bus file §6.5)

```
### CHECKPOINT <id> — <name>
GOAL SEGMENT: <what this segment meant to achieve>
CHANGED: <files touched>
EVIDENCE (real tool output, not claims):
  - test:   <command + pass/fail counts>
  - build:  <command + result>
  - runtime:<curl/db query + actual output>
CLAIMS I AM MAKING: <bullet list of what I assert is now true>
KNOWN GAPS / RISKS: <what was NOT verified, assumptions made>
ADVERSARIAL REVIEW ASKS: <specific things to attack>
|VERDICT REQUESTED: PASS to proceed to <next> / BLOCK
|ACCEPTANCE (Layer 2 — Hermes, judge): <PASS|JUDGE-BLOCK: rationale>
```
|The **Checker agent** (non-Anthropic, Layer 1) replies `PASS` or `BLOCK: <findings>`.
|On BLOCK, the Builder fixes and re-emits the SAME checkpoint. **Fable 5 surfaces
|the bus to Hermes (Layer 2)** — it does NOT self-accept. **Hermes is the
|acceptance-criteria judge**: reads bus + Checker verdicts, may JUDGE-BLOCK a
|Layer-1 PASS on contrarian grounds (scope-creep, budget breach, silent assumption,
|four-eyes theatre), and writes its verdict to the bus with `judge: hermes` + rationale.
|A checkpoint is only **ACCEPTED** when Layer 2 (Hermes) confirms — not when
|Layer 1 alone signs. Raj (Layer 3) flips go-live at 🛑 Z.

---

## 8. CHECKPOINTS (milestone + mid-milestone gates)

🛑 **1a (mid-S1, DB SAFETY):** before bulk insert — prove idempotency (re-run skips) + writes via service/schema not raw tables. Evidence: dry-run 5 rows + count before/after.
🛑 **1 (S1 milestone):** full load done. `SELECT count(*)` + 3 spot-checks vs source JSON. Checker attacks: dup risk, money precision, wrong schema.

🛑 **2 (S2 milestone):** `curl -w %{http_code}` on prod /api/health = 200 + one authed page. Checker attacks: secrets in client bundle, build warnings ignored.

🛑 **3a (mid-S3, SECURITY — non-negotiable):** enumerate EVERY table; prove RLS + org-isolation on each. Evidence: pg_policies query; cross-org read = 0 rows.
🛑 **3 (S3 milestone):** RLS complete + Supabase Pro. Checker attacks: any table without policy, policy that leaks, service-role bypass.

🛑 **9 (S4 milestone, TDD):** failing test first proving old behaviour, then green. Evidence: test names + red→green. Checker attacks: threshold hardcoded, conf==1.0 edge.

🛑 **4a (mid-S5, SECURITY):** zip-bomb guards proven (reject >1000 entries / >200MB; reject non-image/text; path-traversal safe). Evidence: malicious-zip test rejected.
🛑 **4b (mid-S5, PIPELINE):** OCR fan-out (cap 5) + text/image split on 5-file sample. Evidence: sample run.
🛑 **4 (S5 milestone):** REAL zip (`WhatsApp Chat - KoLake Finance and Petty Cash (2).zip`, 517 files) ingested end-to-end into `raj_fin_track`. Evidence: count loaded, DRAFT status, 3 spot-checks. Checker attacks: partial-failure swallowed, non-idempotent re-upload, double-load.

🛑 **8 (S6 milestone, FOUR-EYES):** prove maker≠checker enforced; approve moves Matched-Unverified→Matched-Verified with named checker + timestamp in EvidenceLog. Checker attacks: self-approval possible, POSTED without human, audit gap.

🛑 **5a (mid-S7, PARSER):** parse real CF3 to structured rows; totals tie to statement control (±0.01). Evidence: parsed vs stated totals.
🛑 **5 (S7 milestone):** entries posted (DRAFT), trial balance still balances. Checker attacks: sign errors (in vs out), FX, dup-idempotency, money precision.

🛑 **6 (S8 milestone):** both directions imported; revenue-in booked correctly (not as equity/contra). Evidence: sample rows each direction. Checker attacks: revenue misclassification, dup vs S7/existing.

🛑 **7a (mid-S9, MATCH LOGIC):** matcher on known set — amount+date+payee tiers; prove no false 1:1 across months (the bug from manual run). Evidence: precision on labelled sample.
🛑 **7 (S9 milestone):** May/June reconciliation produced: Matched-Unverified / VerReq / Unallocated; totals reconcile to Wise control (sent=matched+VerReq). Checker attacks: money leakage in totals, VerReq under-flagged, categorisation vs policy, DeepSeek (not Anthropic) used for adjudication.

🛑 **D4 (S10 milestone, TDD):** failing test shows phantom revenue; green shows DR Cash/CR Guest Pre-payments posted. Checker attacks: recognition timing, double-count vs Hostaway sync.

🛑 **11 (S11 milestone, TDD):** failing test shows dup POSTED on re-run without key; green shows idempotencyKey unique-enforced + importers stamp it. Checker attacks: key nullable, not stamped by S5/S7/S8, race on retry.

🛑 **12 (S12 milestone, TDD):** failing test shows POSTED lands in closed period; green shows trigger blocks it + May/June 2026 closed post-S9. Checker attacks: trigger not on all write paths, service-role bypass, partial close.

🛑 **Z — GO-LIVE GATE:** all of: prod 200, RLS complete, real zip + CF3 ingested, May/June recon produced, trial balance = 0, no auto-POST <1.0, tests green, four-eyes enforced, idempotencyKey present on all entries, May/June closed. Evidence bundle for each. Checker does a full adversarial pass before Raj flips go-live.

---

## 9. BUILD ORDER
S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11 → S12 → Z
(Establish vitest/TDD infra during S1; every wave adds tests, never skips RED.)

## 10. TOKEN-ECONOMY REMINDER (Fable 5 — read at every checkpoint)
You reason. You do not toil. Builders edit; Hermes/low-token agents run infra, OCR,
Linear, health-checks, count queries. A checkpoint report is compact; you decide, you delegate the fix.
If you catch yourself about to run a test suite or edit a file directly — STOP and spawn the agent.

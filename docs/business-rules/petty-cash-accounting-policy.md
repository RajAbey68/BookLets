# Ko Lake Villa — Petty Cash & Expense Accounting Policy (SOP)

> **Status:** v1 (2026-07-12). Living business-logic document.
> **Purpose:** The standing operating rules for how Ko Lake Villa classifies and
> verifies expenditure (petty-cash day-books, supplier receipts) before it is
> posted to the BookLets ledger. This is the single source of truth for our
> expense categorization and verification logic — pullable in-app.
> **Basis:** USALI — Uniform System of Accounts for the Lodging Industry
> (11th revised edition), the tier-one hotel-accounting standard.

---

## 1. Chart of Accounts — the five categories

| Category | USALI classification | What belongs here |
|---|---|---|
| **F&B** | Departmental — Food & Beverage (cost of goods sold) | ONLY items bought to **resell** to guests, or **kitchen food ingredients** cooked/prepared for sale (e.g. sugar for the kitchen). |
| **Housekeeping** | Rooms Department expense | Guest-room consumables, amenities, cleaning supplies, and all **complimentary / in-room** items — welcome drinks, in-room tea & Nescafe, soap, shampoo, brooms. |
| **Maintenance** | POMEC (Property Operation & Maintenance) | Repairs, upkeep, spare parts, contractor labour — varnish, key cutting, pump repair fees. |
| **Utilities** | Utilities (undistributed operating expense) | Electric, water, internet/telecoms, **generator diesel** (backup power is a utility), and cooking/hot-water **gas**. |
| **Opex — Transport / A&G** | Administrative & General | **Vehicle/transport fuel** (petrol) and one-off operational purchases that don't fit the buckets above. |

---

## 2. Classification decision rules (apply in order)

1. **Complimentary or in-room?** → **Housekeeping** (welcome drinks, room tea/Nescafe, guest amenities).
2. **Bought for resale, or a kitchen F&B ingredient?** → **F&B**.
3. **Repair / upkeep / parts / contractor labour?** → **Maintenance**.
4. **Generator diesel, electric, water, telecoms, or cooking gas?** → **Utilities**.
   - **Key distinction:** generator diesel = **Utilities** (substitute for grid power); vehicle petrol = **Opex-Transport**. **Fuel is never booked to Maintenance.**
5. **Vehicle fuel or a one-off operational buy?** → **Opex — Transport / A&G**.
6. **Mixed-purpose line?** → **SPLIT by category — never lump.**
   - Example: "gas cylinder + sugar" → gas = **Utilities**, sugar = **F&B**.
   - If the split amounts are unknown → mark **VerReq**, apply a *provisional* split (flagged, not posted) until confirmed.

### The F&B litmus test
- Resold to guest / kitchen prep-for-sale → **F&B**.
- Given free / used in rooms (welcome drink, in-room tea, Nescafe) → **Housekeeping**.
- Same product can fall either side depending on **use**, so classify by purpose, not by item name.

---

## 3. Verification — "trust but verify" (four-eyes)

Every transfer of funds / petty-cash spend is trusted on word but **verified by a
distinct second person** before it is treated as reconciled. Self-verification
never counts.

**Status lifecycle** (the machine can never self-promote to Verified):

| Status | Meaning |
|---|---|
| **Matched–Unverified** | Evidence (receipt) found by amount + date + description; awaiting a named 2nd-person checker. |
| **Matched–Verified** | Evidence found **and** a named second person has signed off. Fully cleared. |
| **VerReq** | No evidence, or ambiguous/conflicting evidence → must be chased then verified. |
| **Unallocated evidence** | A receipt with no matching day-book line (informational). |

**Reconcile each line by amount first**, then confirm description and date.

### Receipt expectation
- **Receipt EXPECTED — chase if missing:** fuel (petrol/diesel), hardware/shop bills (varnish, parts), supermarket purchases (soap, groceries, gas cylinders), and any large single line.
- **Cash-only (paper receipt not chased):** small labour fees (pump repair), small services (key cutting) where a shop slip genuinely doesn't exist.

> **MANDATORY CASH LOG (fraud/tax control — reviewer-mandated GLM-5.2 + Qwen, 2026-07-12):**
> "Not chasing a paper receipt" does NOT mean "undocumented." **Every cash-only
> item must still have a digital log line: date · payee · amount · scope/what-for ·
> who authorised.** No transaction — however small — may be undocumented. Rationale:
> undocumented cash is the primary hospitality leakage/embezzlement vector, and tax
> authorities disallow undocumented cash deductions. The digital log line IS the
> evidence for cash-only items; four-eyes verification then applies to the log, not
> a missing slip.

### Flags to raise on every page
- **Amount matches but description differs** (e.g. day-book "Nescafe" vs receipt "noodles") → note and confirm wording.
- **Receipt total ≠ day-book line** (e.g. receipt circled 9,620 vs line 4,820) → **VerReq**.
- **Cash-on-hand check:** opening float − total spent = expected balance; confirm against actual cash held.

### Posting gate
**Nothing posts to the BookLets ledger while any VerReq is open on a page.** The
owner (Raj) reviews the categorized page and open flags before anything is posted.

---

## 4. Scrutiny clarifications (bookkeeper queries)

When lines need clarification, draft the first-level scrutiny questions as an
**email** (preferred channel — longer form, threaded, on record), grouped by line,
in plain language, framed as normal scrutiny (not accusation). Offer a Sinhala
translation where the recipient prefers it. A terse WhatsApp version is produced
only on explicit request.

---

## 5. Worked example — 8 July 2026 day-book (Rohan's Petty Cash, total 45,506)

Opening float Rs 50,000 · spent Rs 45,506 · expected cash on hand Rs 4,494.

| Item | Amount | Category | Verification |
|---|---|---|---|
| Petrol (Mrs Sudha) | 12,798 | Opex — Transport | **Chase fuel receipt** |
| Key cutting, 5 nos | 4,500 | Maintenance | Cash-only OK |
| Varnish, Room 2 | 2,350 | Maintenance | **Chase shop bill** |
| Pradeep — pressure pump fee | 2,000 | Maintenance | Cash-only OK |
| 40 L diesel, generator | 15,280 | **Utilities** | Receipt held (Lanka Filling) |
| Gas cylinder + sugar | 4,820 | **Split:** gas=Utilities, sugar=F&B | **VerReq** — split unknown; receipt total conflict (9,620 vs 4,820) |
| Welcome drink, 14 pax | 618 | Housekeeping | Receipt held (B.K. Sampath) — confirm |
| Broom | 655 | Housekeeping | Receipt held (Cargills) |
| Nescafe / noodles | 490 | Housekeeping | Receipt held — description mismatch, confirm |

---

## 6. Maintenance

- This document is the canonical business logic. The agent-side procedural copy is
  the Hermes skill `kolake-petty-cash-categorization`; keep the two in sync when
  rules change.
- Amendments are versioned in git. Any change to categories or the F&B / Utilities
  boundary must be recorded here with a date and rationale.

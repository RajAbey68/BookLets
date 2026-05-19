# BookLets — User Help

> **Audience.** Bookkeeper, accountant, villa captain, operator, external reviewer.
> **Online URL.** The canonical version of this document lives at
> [`github.com/RajAbey68/BookLets/blob/main/docs/HELP.md`](https://github.com/RajAbey68/BookLets/blob/main/docs/HELP.md).
> In-app: open `/help` (no sign-in required).
> **Last updated.** This file is versioned in git — `git log docs/HELP.md` shows the history.

---

## 1. What BookLets is

BookLets is the in-house accounting and operations system for the **Ko Lake**
short-term-rental portfolio. It records income and expenses, attributes
revenue to the correct period, produces a clean general ledger, and exports
monthly numbers for QuickBooks Online or the accountant's filing pack.

- **Books in:** LKR (Sri Lankan rupees), recorded exactly as the transaction
  happened.
- **Reports in:** USD using the spot FX rate on month-close (preferred: a
  monthly average where a daily feed is available).
- **Framework:** SLFRS (Sri Lanka Financial Reporting Standards) is the
  canonical default. Swappable to other GAAP/IFRS standards if the portfolio
  expands overseas.
- **Channel feeds:** Hostaway pulls bookings and properties from
  Booking.com, Airbnb, direct, etc.
- **Filing surface:** QuickBooks Online (CSV export).

---

## 2. Monthly workflow

| # | Step | Where in BookLets | Owner |
|---|------|-------------------|-------|
| 1 | Record petty-cash and operating expenses in the operator's monthly Income & Petty Cash Analysis workbook | external `.xlsx` (today) | Villa captain |
| 2 | Upload the workbook to BookLets — parses every row, classifies to a chart-of-accounts code, shows a preview | `/imports` | Bookkeeper |
| 3 | Review the preview — per-section totals, unmapped columns, rows flagged with warnings; fix the source workbook and re-upload if needed | `/imports` preview | Bookkeeper |
| 4 | **Confirm & post** — BookLets writes balanced double-entry journal entries to the ledger; idempotent on re-upload | `/imports` (P2, next phase) | Bookkeeper |
| 5 | Reconcile to the bank — match cleared transactions, queue exceptions | `/reconcile` (P4, planned) | Bookkeeper |
| 6 | Run FX revaluation at month close (LKR → USD) | month-close action (P5) | Accountant |
| 7 | Export ledger CSV → import into QuickBooks Online | "Export CSV" link | Accountant |

---

## 3. Screens

### 3.1 Sign-in — `/login`  *(public)*

Centred card with **Continue with Google** as the only sign-in method. Email
must be on the operator's allow-list. If you see "Access Denied", forward
your Google address to the operator so they can add it.

> **Fail-closed.** If the allow-list is accidentally cleared in production,
> sign-in fails for everyone. Deliberate: the operator would rather lock
> themselves out than admit an unauthorised account into the books.

---

### 3.2 Dashboard — `/`  *(home after sign-in)*

One-glance view of how the portfolio is performing this month.

**Stat cards (top):**
- **Total Revenue** — month-to-date gross income recognised in the ledger.
- **Net Income** — revenue minus operating expenses; margin shown beneath.
- **ADR / RevPAR** — average daily rate, and revenue per available room.
- **Portfolio Occupancy** — % of available room-nights actually sold this month.

**Below the cards:**
- **Receipt uploader** — drop a photo or scan; gets attached to an expense.
- **Revenue Trend** — gross revenue + net income bar chart for recent months.
- **Property Yield** — per-villa headline numbers, link into `/properties`.

**Header buttons:**
- **Download Report** — exports the ledger CSV for the period.
- **+ Create Entry** — opens the ledger so you can add a manual journal entry.

---

### 3.3 Properties — `/properties`

One card per villa with the financial picture for that asset.

| Card element | Meaning |
|-------------|--------|
| Status pill | Active / paused / in-setup |
| Total Revenue | Period-to-date gross income for that villa |
| Net Yield | Revenue minus directly attributable cost |
| ADR | Average daily rate over occupied nights |
| RevPAR | Revenue per available room-night (includes vacant nights) |
| Occupancy bar | Visual % of nights sold vs available |
| **Details →** | Drills into the per-property page (bookings, costs, manager) |

**Top-right action — Sync Properties:** pulls the latest property list and
metadata from Hostaway so BookLets stays aligned with live inventory.

---

### 3.4 Bookings — `/bookings`

Single ordered table of every reservation, regardless of channel.

| Column | Meaning |
|--------|--------|
| ID | Hostaway booking reference, or BookLets' internal short ID if entered manually |
| Property | Which villa |
| Channel | Booking.com, Airbnb, direct, etc. |
| Check In / Check Out | Stay dates. **Check-out date** decides the revenue month |
| Total | Gross reservation value in the channel's billing currency |
| Status | Confirmed · Completed · Pending · Cancelled |

**+ Create Booking** — manual entry for direct bookings that didn't come
through a channel.

> **Revenue recognition.** Status moves to **Completed** on check-out. The
> entire stay revenue lands in the check-out month, even if the stay started
> in the previous month. No day-by-day apportionment — refund risk is
> effectively closed by check-out.

---

### 3.5 General Ledger — `/ledger`

The double-entry journal. Every transaction recorded in BookLets appears
here, in chronological order, with full debit/credit detail.

| Column | Meaning |
|--------|--------|
| Date | Transaction date (when it happened — not posting date) |
| Reference | 8-character entry ID. Every line of a single journal entry shares the same Reference and balances to zero |
| Account | Chart-of-accounts line item, e.g. `4000 Rent Income` or `6200 Electricity` |
| Memo | Description as entered or imported |
| **Debit** (green) | Increases assets and expenses; decreases income and liabilities |
| **Credit** (red) | Increases income and liabilities; decreases assets and expenses |

**Filters & export:**
- **Period filter** — dropdown auto-populated with every month that has
  activity, plus "All Time".
- **Export CSV** — a file ready to import into QuickBooks Online.

---

### 3.6 Imports — `/imports`  *(Preview only — confirm-and-post in P2)*

Where you upload the monthly Income & Petty Cash Analysis workbook.
Read-only preview today; the confirm-and-post step writes journal entries
in the next phase.

**How to use it:**
1. Drop the `.xlsx` for the month. Limit 10 MB.
2. BookLets parses every row, reads column headers, and matches each amount
   to a chart-of-accounts code.
3. A preview appears below the form. Nothing is written to the ledger.

**Preview sections:**
- **Summary card** — period label, total rows, net amount, file fingerprint
  (sha256 prefix), warning count, unmapped-column count.
- **Totals by account, per section** — one mini-table per section: Prior-Month
  Catch-up, Daily, Recurring, Accruals, Accrual Reversals, Prepayments,
  Prepayment Reversals.
- **Unmapped columns** — amber banner listing column headers BookLets
  couldn't match. Amounts in those columns are ignored until the mapping is
  added by the operator.
- **Per-section row tables** — every row with date, description, petty cash
  top-up, postings list, and any quality warnings.

**Warning flags you may see:**
- `date forward-filled from previous row` — date cell was blank; filled from
  the row above. Marked with an orange `*` in the table.
- `petty-cash entry > LKR 5,000 has no description` — the petty cash
  convention requires a memo above this threshold.
- `one or more amounts in unmapped columns` — a column header needs to be
  added to the chart mapping.
- `evidence-quality flag in description` — words like "no receipt",
  "handwritten", or "no date" detected; useful for receipt chase-up.

---

## 4. Chart of accounts

36 lines, drafted directly from the operator's monthly workbook.

### Assets · 1xxx
| Code | Name | Notes |
|------|------|-------|
| 1010 | Petty Cash | Float held by the villa captain. Top-ups debited here. |
| 1100 | Bank — LKR Current | Operating bank account (in setup). |
| 1200 | Bank — USD Holding | Reserved for USD float once the USD account opens. |
| 1300 | Accounts Receivable | Money owed by guests / channels. |
| 1500 | Prepayments | Costs paid in advance (insurance, subscriptions). |

### Liabilities · 2xxx
| Code | Name | Notes |
|------|------|-------|
| 2000 | Accounts Payable | Money owed to suppliers. |
| 2100 | Accruals | Expenses incurred but not yet paid. |
| 2200 | APIT Payable | Sri Lanka income tax withheld from staff pay. |
| 2210 | EPF Payable | Employees' Provident Fund (8% employee + 12% employer). |
| 2220 | ETF Payable | Employees' Trust Fund (3% employer). |
| 2300 | Channel Holdback / Reserve | Amounts retained by channels (e.g. Airbnb hold). |

### Equity · 3xxx
| Code | Name |
|------|------|
| 3000 | Owner Contributions |
| 3100 | Retained Earnings |

### Revenue · 4xxx
| Code | Name |
|------|------|
| 4000 | Rent Income |
| 4010 | Cleaning Fee Income |
| 4020 | Event Income |
| 4030 | F&B Income |
| 4090 | Other Income |

### Cost of sales · 5xxx
| Code | Name |
|------|------|
| 5100 | Food & Beverage Expense |
| 5110 | Refunds |

### Operating expenses · 6xxx
| Code | Name |
|------|------|
| 6100 | Salaries (gross) |
| 6110 | Wages (net cash) |
| 6120 | Bonus |
| 6130 | Staff Welfare |
| 6140 | Complementaries |
| 6150 | Statutory Contributions (employer share of EPF + ETF) |
| 6200 | Electricity |
| 6210 | Water |
| 6220 | Telephone / Internet |
| 6230 | Software |
| 6300 | Cleaning & Maintenance |
| 6310 | Laundry & Housekeeping |
| 6320 | Pool & Garden |
| 6330 | Gym Related |
| 6400 | Fuel |
| 6410 | Gas |
| 6420 | Travelling |
| 6490 | Other Operational Expense |
| 6500 | Sales Promotion |
| 6510 | Commission |
| 6600 | Admin Expense (Professional / Bookkeeping / Legal) |
| 6700 | Loan Repayment |

### Capex · 7xxx
| Code | Name |
|------|------|
| 7100 | Minor Capex |
| 7200 | Major Capex |

### Suspense · 9999
| Code | Name | Notes |
|------|------|-------|
| 9999 | Suspense | Amounts that couldn't be classified at import time. Cleared by the operator before period close. |

---

## 5. Accounting policies (the rules BookLets enforces)

### 5.1 Currency & FX
- Books are kept in LKR.
- Reporting currency is USD.
- FX rate applied at **month close** — the spot rate on the last day of the
  month. Where a daily feed is available, the **monthly average** is used
  instead (smooths volatility).
- Per-entry FX is **not** used.

### 5.2 Revenue recognition
- A guest's entire stay revenue is booked to the **check-out month**.
- No day-by-day apportionment across month boundaries.
- Rationale: refund risk effectively closes on check-out, so the contract is
  earned by then.

### 5.3 Petty cash
- A float of cash is held by the **villa captain**.
- Used for small operating purchases — typically under LKR 5,000.
- Top-ups debit **1010 Petty Cash**.
- Items above LKR 5,000 require a memo explaining the use (the importer
  flags violations).

### 5.4 Payroll
- **6100 Salaries** — gross salary (the headline number on payslips).
- **6110 Wages** — net cash paid to staff after deductions.
- **6120 Bonus** — variable payments separate from base salary.
- **2200 APIT Payable** — income tax withheld from staff; remitted to the
  IRD monthly.
- **2210 EPF Payable** — 8% employee + 12% employer = 20% of gross.
  Remitted to EPF monthly.
- **2220 ETF Payable** — 3% employer only. Remitted to ETF monthly.
- **6150 Statutory Contributions** — employer share of EPF + ETF expensed
  here, with the corresponding payable on the liability side.

### 5.5 Booking-month attribution
See §5.2. The check-out date in the Bookings table determines the period
the stay revenue belongs to.

### 5.6 Receipts / evidence
- Receipts are uploaded via the receipt uploader on the Dashboard, or in
  bulk to Google Drive (P8, planned).
- Each expense will carry an **evidence type** flag:
  - `PRINTED` — printed receipt or e-receipt.
  - `HANDWRITTEN` — handwritten chit, possibly in Sinhala.
  - `MISSING` — known cash-in-hand work, no receipt expected.
  - `NA` — receipt not applicable (e.g. salary).
- Handwritten Sinhala receipts will be OCR'd and translated when P8 ships.

### 5.7 Framework
- **SLFRS** — Sri Lanka Financial Reporting Standards. This is what the
  operator's local accountant works against, and what BookLets references
  for any accounting-method question.
- The framework is swappable in BookLets' configuration — if the portfolio
  expands overseas, an instance can be switched to UK GAAP, US GAAP,
  IFRS, etc.

---

## 6. Roadmap

| Phase | Feature | Status |
|------|---------|--------|
| P0 | Chart of accounts (36 lines) | **Live** |
| P1 | Spreadsheet parser + read-only preview | **Preview** |
| P2 | Confirm-and-post (write balanced journal entries; idempotent) | Planned |
| P3 | Editable grid (fix/re-classify before posting) | Planned |
| P4 | Bank reconciliation | Planned |
| P5 | Month-close (FX revaluation + accountant export pack) | Planned |
| P6 | STR dashboards (channel mix, seasonality, yield deep dives) | Planned |
| P7 | Capex tracker + forecast editor | Planned |
| P8 | Google Drive receipts pipeline (OCR, P/H flag, Sinhala translation) | Planned |
| P9–11 | In-app AI chat dialog — database-grounded, SLFRS-sourced | Planned |

---

## 7. Glossary

| Term | Meaning |
|------|---------|
| **Accrual** | An expense incurred but not yet paid. Recorded in the period it relates to, not the period it's paid. |
| **Accrual reversal** | The opposite entry that cancels a prior-period accrual once the bill is actually paid. |
| **ADR** | Average Daily Rate. Revenue ÷ occupied room-nights. |
| **APIT** | Advance Personal Income Tax — Sri Lankan income tax withheld from staff pay. |
| **Chart of accounts** | The numbered list of account categories used to classify every transaction. |
| **Channel** | A booking platform — Booking.com, Airbnb, etc. — or the "direct" channel for guest-to-villa bookings. |
| **Check-out month** | The calendar month containing the stay's check-out date. Determines the revenue period (see §5.2). |
| **Credit** | The right-hand side of a journal entry. Increases income and liabilities; decreases assets and expenses. |
| **Debit** | The left-hand side of a journal entry. Increases assets and expenses; decreases income and liabilities. |
| **Double-entry** | The accounting rule that every transaction has equal debits and credits — the ledger always balances. |
| **EPF** | Employees' Provident Fund (Sri Lanka). 8% employee + 12% employer = 20% of gross salary. |
| **ETF** | Employees' Trust Fund (Sri Lanka). 3% employer-only. |
| **FX** | Foreign exchange. The rate at which LKR converts to USD for reporting. |
| **GL / general ledger** | The chronological list of journal entries — the system of record. |
| **Hostaway** | The channel manager. Pulls bookings from every platform into one place. |
| **IFRS** | International Financial Reporting Standards. SLFRS is the Sri Lankan adoption. |
| **Idempotent** | An operation that has the same effect whether run once or many times. Re-uploading a spreadsheet doesn't double-post. |
| **Journal entry** | A balanced set of debit and credit lines representing one transaction. Identified by an 8-character Reference in the ledger. |
| **Petty cash** | Small cash float held by the villa captain (§5.3). |
| **Prepayment** | A cost paid in advance — recorded as an asset and expensed over the period it covers. |
| **Prepayment reversal** | The opposite entry that consumes a prepayment as the period passes. |
| **RevPAR** | Revenue per available room-night. Revenue ÷ available room-nights (occupied + vacant). |
| **SLFRS** | Sri Lanka Financial Reporting Standards. BookLets' default accounting framework. |
| **Suspense** | Account 9999 — temporary parking for amounts that can't be classified at import time. |
| **Year-to-date / Month-to-date** | The period from the start of the (year / month) to today. |

---

## 8. Frequently asked questions

**1. Can I edit a transaction after it's posted to the ledger?**
Posting is reversible by adding a contra entry; the original entry is never
deleted. The audit trail must remain intact. P3 will surface this as an
"adjust" action.

**2. What happens if I upload the same monthly spreadsheet twice?**
Once P2 ships, posting is **idempotent** — BookLets fingerprints each
source row and refuses to post a duplicate. The preview will show "already
posted, nothing to do".

**3. A column in my spreadsheet shows up under "Unmapped columns" — what do I do?**
Send the column header text to the operator. They'll add the mapping to
the chart of accounts, after which the column will be picked up on the
next upload.

**4. Why is the check-out month used for revenue, not check-in?**
By check-out, the contract is effectively complete — refund risk has
closed. Apportioning across months adds complexity without a real
accounting benefit at the operator's scale.

**5. Where do I see the USD equivalent of LKR balances?**
USD is applied at month-close (§5.1). During the month, the books show
LKR only. After close, both LKR and USD columns are available on the
exports.

**6. The petty cash top-up shows LKR 50,000 on one row — is that wrong?**
Probably not. Top-ups are occasional and large; the day-to-day spend is
the smaller numbers in the expense columns. The 5,000 LKR threshold (§5.3)
is for individual *purchases*, not top-ups.

**7. Who can sign in?**
Only Google accounts on the operator's allow-list. Each email is approved
individually. Removing an email immediately revokes access.

**8. What happens to expenses with no receipt?**
They post normally but carry an evidence flag (`MISSING`). Once P8 ships,
these rows surface on a "receipts to chase" view; some operations
(cash-in-hand work) will always be `MISSING` by design.

**9. Will I see Sinhala receipts translated?**
Yes — once P8 ships, handwritten Sinhala receipts are OCR'd and
translated automatically into a separate month-ordered book.

**10. Is the data secure?**
Sign-in requires Google + allow-list. The database has row-level security
enabled. Every API call is gated by middleware. Production environment
variables are stored in Vercel's encrypted vault, not in the repository.

**11. Can my accountant get a snapshot for filing?**
Yes — the Export CSV link on the Ledger and Dashboard produces a file
formatted for QuickBooks Online import. The P5 month-close action will
add a comprehensive "accountant pack" (trial balance, P&L, balance sheet,
exception list).

**12. What about VAT / GST?**
Sri Lanka VAT thresholds and treatment will be added as a chart-of-accounts
extension when the portfolio crosses the registration threshold.
Until then, all sales are non-VAT.

---

## 9. Troubleshooting

**The upload says "File is too large".**
The limit is 10 MB. The monthly workbook is normally under 100 KB; if
yours is huge, save it as a fresh `.xlsx` to drop embedded images.

**The upload says "Unsupported file type".**
Save the file as `.xlsx` (not `.xls`, not `.numbers`, not Google Sheets
native format). Use *Save As → Excel Workbook (.xlsx)* in Excel or *File
→ Download → Microsoft Excel (.xlsx)* in Google Sheets.

**The upload says "Could not locate the header row".**
The parser looks for "Rent Income" within the first 8 rows. If the sheet
has been heavily restructured, restore the canonical header row or send
the file to the operator.

**Dates are flagged with orange asterisks.**
The date cell was blank for those rows; BookLets carried forward the
previous row's date. Audit the spreadsheet — sometimes this is correct
(multiple rows for the same day), sometimes it indicates a missing entry.

**Per-section totals don't match the spreadsheet's own subtotals.**
Re-export the file from Excel to flatten formulas, then re-upload. If the
mismatch persists, send the file to the operator with a screenshot of the
discrepancy.

**I'm signed in but the Dashboard is empty.**
Either no bookings exist yet for the period, or no organisation has been
provisioned for your account. Check with the operator that your user is
attached to the right organisation.

---

## 10. Where to get help

- **Bugs / feature requests:** file an issue at
  [`github.com/RajAbey68/BookLets/issues`](https://github.com/RajAbey68/BookLets/issues).
- **Accounting policy questions:** ask the operator's accountant. SLFRS
  is the canonical reference.
- **Day-to-day usage questions:** use the BookLets Help Assistant — see
  [`docs/LLM-ASSISTANT.md`](LLM-ASSISTANT.md) for setup.

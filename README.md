# BookLets: Open Source Bookkeeping for Short-Term Lettings

BookLets is a specialized financial management system designed for property managers, short-term rental (STR) hosts, and small business owners. It provides a robust, double-entry accounting framework to manage properties, guest bookings, and operational expenses.

## Core Outcomes

- **Property & Unit Tracking**: Manage property portfolios, owner details, and revenue-sharing logic.
- **Double-Entry Ledger**: A canonical financial system of record supporting Assets, Liabilities, Equity, Revenue, and Expenses (ALERE).
- **Rental Management**: Track guest bookings across channels (Airbnb, Booking.com, Direct) and manage payouts.
- **Expense Intelligence**: Categorize and track operational expenses to generate accurate Profit & Loss statements.

## Documentation

- **User help:** [`docs/HELP.md`](docs/HELP.md) — comprehensive guide for the bookkeeper, accountant, and operator (screens, workflow, chart of accounts, policies, glossary, FAQ).
- **Bookkeeper / accountant deck:** [`docs/booklets-walkthrough.html`](docs/booklets-walkthrough.html) (and `.pptx`) — visual walkthrough.
- **LLM assistant setup:** [`docs/LLM-ASSISTANT.md`](docs/LLM-ASSISTANT.md) — how to stand up a NotebookLM-based help assistant grounded only in BookLets sources.
- **NotebookLM source bundle:** [`docs/llm-sources/`](docs/llm-sources/README.md) — what to load into the notebook and in what order.

> NotebookLM notebook URL: *to be added by the operator once the notebook is created.*

## Getting Started

1. **Install Dependencies**: `npm install`
2. **Setup Database**: `npx prisma migrate dev`
3. **Run Application**: `npm run dev`

---
*Note: This application is a dedicated business tool for financial operations in the lettings and SMB sector.*

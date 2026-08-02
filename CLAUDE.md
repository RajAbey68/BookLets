<!-- BEGIN:ingestion-rule -->
# READ FIRST — the sandbox-first rule

**Nothing reaches the ledger without passing through the sandbox first.**

Receipts and payments are ingested into `sandbox.*`, reviewed by a human, and
only then booked into `public."JournalEntry"`. Every ingest path obeys this.
No fast path. No exception for high model confidence.

Dates are never fabricated. Currency comes from the account, never the schema
default. Everything an AI touched lands DRAFT and needs four eyes.

**Full contract, invariants and the agent checklist: [`docs/INGESTION-DESIGN.md`](docs/INGESTION-DESIGN.md).**
Read it before changing anything that writes to the ledger.
<!-- END:ingestion-rule -->

@AGENTS.md

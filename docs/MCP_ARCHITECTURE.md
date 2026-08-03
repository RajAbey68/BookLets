# MCP Server Architecture

## Overview

Two MCP servers enable cross-app queries between BookLets (financial ledger) and WhatHappen (chat forensics):

- **BookLets MCP Server** (`/api/mcp/booklets`) — exposes financial data for WhatHappen to correlate
- **WhatHappen MCP Server** (TBD in WhatHappen repo) — exposes message search for BookLets to provide context

## BookLets MCP Server (`/api/mcp/booklets/route.ts`)

### Tools

1. **`get_journal_entries(from, to, status?)`**
   - Returns journal entries (ledger lines) in a date range
   - Optional `status` filter: `DRAFT` | `POSTED`
   - Org-scoped (RLS enforced)
   - Use case: "What ledger entries exist for July?"

2. **`get_expenses(from, to, vendor?, category?)`**
   - Returns expenses with optional vendor/category filters
   - Substring matching on vendor name
   - Org-scoped, property-scoped (all properties in org)
   - Use case: "Find all cleaning expenses in June"

3. **`get_bookings(from, to)`**
   - Returns confirmed bookings (revenue events)
   - Date range: overlapping check-in/check-out
   - Use case: "What properties had guests in this period?"

4. **`get_account_balance(accountCode)`**
   - Returns current balance for a given account
   - Read-only, sums POSTED entries only
   - Use case: "What's the cash balance?"

### Design

- **Auth**: Resolves org context from session (NextAuth)
- **Scope**: All queries org-scoped via RLS (`runWithOrgContext`)
- **Pagination**: All list endpoints return up to 50 rows
- **Format**: JSON-RPC 2.0 (standard MCP protocol)
- **Date handling**: ISO 8601 strings parsed to Date

## WhatHappen MCP Server (TBD)

Should expose similar tools for message queries:

1. **`search_messages(from, to, query)`**
   - Full-text or keyword search in messages
   - Date range filtered
   - Project-scoped (WhatHappen project ID)

2. **`get_financial_mentions(from, to)`**
   - Extract messages mentioning currency, payment terms, debts
   - Sentiment score or confidence if available

3. **`get_timeline_events(from, to)`**
   - Key milestones or status changes in chat
   - Useful for correlation with booking events

4. **`get_participants(projectId)`**
   - List chat participants and message counts

### Design Pattern

- Use WhatHappen's Supabase + message_meta tables (already time-partitioned)
- Resolve project context from request (similar to BookLets org)
- Return aggregates, not raw message dumps (keep context windows manageable)
- Same JSON-RPC 2.0 format for consistency

## Integration Flow

1. **User in WhatHappen asks**: "Was this payment mentioned in July?"
   - WhatHappen AI calls `get_journal_entries(july_from, july_to)` on BookLets MCP
   - Receives: all ledger entries for that period
   - AI cross-references with chat messages to answer

2. **User in BookLets asks**: "What's the context for this vendor payment?"
   - BookLets AI calls `search_messages(date, vendor_name)` on WhatHappen MCP
   - Receives: matching chat excerpts
   - AI builds a narrative linking the payment to conversation

## Linking Queries

The two services need a **mapping table** to join by entity (not just date):

```prisma
model ExternalContextLink {
  id              String   @id @default(cuid())
  organizationId  String
  sourceType      String   // "booking" | "expense" | "vendor" | "owner"
  sourceId        String   // BookLets entity ID
  externalSystem  String   // "whathappen"
  externalProjectId String // WhatHappen project ID
  externalParticipant String? // WhatHappen participant name
  createdAt       DateTime @default(now())
  organization    Organization @relation(fields: [organizationId], references: [id])

  @@unique([organizationId, sourceType, sourceId, externalSystem])
  @@index([organizationId, externalSystem])
}
```

This lets queries like: "Show me all messages about Owner X" → resolve Owner ID → find linked WhatHappen project → query messages.

## Security

- **Auth scope**: Each MCP request resolved to its org/project
- **RLS**: BookLets MCP enforces `app.current_org_id` via Postgres RLS
- **WhatHappen**: Should similarly scope to project owner/organization
- **Tool restrictions**: Read-only (no writes via MCP)
- **Rate limiting**: TBD; consider token budgets if called by OpenRouter

## Testing

```bash
# Test BookLets MCP locally:
curl -X POST http://localhost:3000/api/mcp/booklets \
  -H "Content-Type: application/json" \
  -H "Cookie: <session-cookie>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'
```

## Next Steps

1. ✅ BookLets MCP server scaffolded
2. TBD: WhatHappen MCP server (in WhatHappen repo)
3. TBD: ExternalContextLink migration
4. TBD: Wire both AI layers (ai@v4.2+) to consume MCP servers
5. TBD: E2E test (cross-app query flow)

import { NextRequest, NextResponse } from 'next/server';
import { resolveActiveContext } from '@/lib/auth-context';
import { prisma } from '@/lib/prisma';
import { runWithOrgContext } from '@/lib/org-context';
import { Decimal } from 'decimal.js';

export const dynamic = 'force-dynamic';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: Tool[] = [
  {
    name: 'get_journal_entries',
    description: 'Fetch journal entries for a date range, optionally filtered by status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: {
          type: 'string',
          description: 'Start date (ISO 8601)',
        },
        to: {
          type: 'string',
          description: 'End date (ISO 8601)',
        },
        status: {
          type: 'string',
          enum: ['DRAFT', 'POSTED'],
          description: 'Filter by entry status (optional)',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_expenses',
    description: 'Fetch expenses for a date range, optionally filtered by vendor or category.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: {
          type: 'string',
          description: 'Start date (ISO 8601)',
        },
        to: {
          type: 'string',
          description: 'End date (ISO 8601)',
        },
        vendor: {
          type: 'string',
          description: 'Filter by vendor name (optional, substring match)',
        },
        category: {
          type: 'string',
          description: 'Filter by expense category (optional)',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_bookings',
    description: 'Fetch bookings for a date range.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: {
          type: 'string',
          description: 'Start date (ISO 8601)',
        },
        to: {
          type: 'string',
          description: 'End date (ISO 8601)',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_account_balance',
    description: 'Get the current balance for an account (read-only ledger query).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        accountCode: {
          type: 'string',
          description: 'The account code (e.g., "1000", "5000")',
        },
      },
      required: ['accountCode'],
    },
  },
];

async function handleToolCall(
  organizationId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string> {
  return runWithOrgContext(organizationId, async () => {
    const from = new Date(toolInput.from as string);
    const to = new Date(toolInput.to as string);

    switch (toolName) {
      case 'get_journal_entries': {
        const entries = await prisma.journalEntry.findMany({
          where: {
            organizationId,
            date: { gte: from, lte: to },
            ...(toolInput.status ? { status: toolInput.status as string } : {}),
          },
          include: {
            lines: { include: { account: true } },
          },
          orderBy: { date: 'desc' },
          take: 50, // Pagination limit
        });

        return JSON.stringify({
          count: entries.length,
          entries: entries.map((e) => ({
            id: e.id,
            date: e.date.toISOString().slice(0, 10),
            status: e.status,
            memo: e.memo,
            source: e.source,
            sourceId: e.sourceId,
            lines: e.lines.map((l) => ({
              accountCode: l.account.code,
              accountName: l.account.name,
              amount: l.amount.toString(),
              isDebit: l.isDebit,
              currency: l.currency,
            })),
          })),
        });
      }

      case 'get_expenses': {
        const expenses = await prisma.expense.findMany({
          where: {
            propertyId: {
              in: await prisma.property
                .findMany({ where: { organizationId }, select: { id: true } })
                .then((p) => p.map((x) => x.id)),
            },
            date: { gte: from, lte: to },
            ...(toolInput.vendor
              ? {
                  vendor: {
                    name: { contains: toolInput.vendor as string, mode: 'insensitive' },
                  },
                }
              : {}),
            ...(toolInput.category
              ? {
                  expenseCategory: {
                    name: { contains: toolInput.category as string, mode: 'insensitive' },
                  },
                }
              : {}),
          },
          include: { vendor: true, expenseCategory: true, property: true },
          orderBy: { date: 'desc' },
          take: 50,
        });

        return JSON.stringify({
          count: expenses.length,
          expenses: expenses.map((e) => ({
            id: e.id,
            date: e.date.toISOString().slice(0, 10),
            property: e.property.name,
            vendor: e.vendor.name,
            category: e.expenseCategory.name,
            amount: e.amount.toString(),
            description: e.description,
            confidenceScore: e.confidenceScore,
          })),
        });
      }

      case 'get_bookings': {
        const bookings = await prisma.booking.findMany({
          where: {
            propertyId: {
              in: await prisma.property
                .findMany({ where: { organizationId }, select: { id: true } })
                .then((p) => p.map((x) => x.id)),
            },
            checkIn: { lte: to },
            checkOut: { gte: from },
          },
          include: { property: true, charges: true },
          orderBy: { checkIn: 'desc' },
          take: 50,
        });

        return JSON.stringify({
          count: bookings.length,
          bookings: bookings.map((b) => ({
            id: b.id,
            property: b.property.name,
            checkIn: b.checkIn.toISOString().slice(0, 10),
            checkOut: b.checkOut.toISOString().slice(0, 10),
            totalAmount: b.totalAmount.toString(),
            status: b.status,
            chargeCount: b.charges.length,
          })),
        });
      }

      case 'get_account_balance': {
        const account = await prisma.account.findFirst({
          where: {
            organizationId,
            code: toolInput.accountCode as string,
          },
        });

        if (!account) {
          return JSON.stringify({ error: 'Account not found' });
        }

        const lines = await prisma.journalLine.findMany({
          where: {
            accountId: account.id,
            journalEntry: { status: 'POSTED' },
          },
        });

        const balance = lines.reduce((acc, line) => {
          const amount = new Decimal(line.amount.toString());
          return line.isDebit ? acc.plus(amount) : acc.minus(amount);
        }, new Decimal(0));

        return JSON.stringify({
          accountCode: account.code,
          accountName: account.name,
          balance: balance.toString(),
          currency: 'EUR',
        });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  });
}

async function handleJsonRpcRequest(req: JsonRpcRequest, organizationId: string): Promise<JsonRpcResponse> {
  const { id, method, params } = req;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'booklets-mcp', version: '1.0.0' },
      },
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    };
  }

  if (method === 'tools/call') {
    const { name, arguments: toolArgs } = params as { name: string; arguments: Record<string, unknown> };
    try {
      const result = await handleToolCall(organizationId, name, toolArgs);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          type: 'text',
          text: result,
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : 'Tool execution failed',
        },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found' },
  };
}

export async function POST(request: NextRequest) {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 401 });
  }

  const { organizationId } = resolved.context;

  try {
    const body = await request.json();
    const response = await handleJsonRpcRequest(body, organizationId);
    return NextResponse.json(response);
  } catch (err) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      },
      { status: 400 },
    );
  }
}

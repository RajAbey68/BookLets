import { getPLStatementReport } from '@/lib/pl-statement-report';
import { getTrialBalanceReport } from '@/lib/trial-balance-report';
import { getBalanceSheetReport, resolveAsOf } from '@/lib/balance-sheet-report';
import { fetchDraftReviewQueue } from '@/app/actions/approval.actions';
import { resolveActiveContext } from '@/lib/auth-context';
import { runWithOrgContext } from '@/lib/org-context';
import { MetricsService } from '@/lib/metrics.service';
import type { PLSection } from '@/lib/pl-statement';
import type { BalanceSheetSection } from '@/lib/balance-sheet';

/**
 * Read-only ledger tools for the voice assistant.
 *
 * Three properties this file exists to guarantee:
 *
 *  1. **Read-only by construction.** There is no write tool here and no way to
 *     add one through this registry — every `execute` calls a report/query
 *     function and returns a plain object. Speech is the weakest evidence
 *     BookLets accepts (STT mis-hears numbers routinely: "fifteen hundred" and
 *     "fifty hundred" are one phoneme apart), so nothing spoken may reach a
 *     double-entry ledger. Posting stays on the four-eyes path in /review.
 *
 *  2. **Org-scoped like every other read path.** Each tool resolves the
 *     caller's context itself rather than trusting anything the model said.
 *     The report helpers (`getPLStatementReport` etc.) already call
 *     `resolveActiveContext`, so a signed-out caller gets `{ ok: false }`
 *     rather than another tenant's numbers. Tools that query Prisma directly
 *     wrap the call in `runWithOrgContext` so RLS applies (fail closed: no
 *     context → zero rows).
 *
 *  3. **Small enough to say out loud.** Results are capped and rounded to two
 *     decimals. A trial balance can run to hundreds of accounts; reading all
 *     of them aloud is useless, and pushing them through the model is a waste
 *     of tokens. Each tool returns totals plus the largest few rows, and says
 *     how many rows it left out so the agent can be honest about the cap.
 *
 * Amounts are bare numeric strings. BookLets carries currency per journal line
 * (default EUR), not per report, so no tool here can name one — the system
 * prompt tells the agent not to invent a currency symbol.
 */

/** Rows returned per section — enough to be useful, few enough to speak. */
const SECTION_ROW_CAP = 8;
/** Pending approvals surfaced in one answer. */
const APPROVAL_CAP = 10;

export type AgentToolResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's input, passed to the model verbatim. */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (input: Record<string, unknown>) => Promise<AgentToolResult>;
}

/** Anything Decimal-like the report layer hands back. */
type Amountish = { toFixed(dp: number): string };

const money = (value: Amountish): string => value.toFixed(2);

/** Reads a string arg defensively — the model supplies these, not our code. */
const str = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

/**
 * Top-level rows of a section, largest first, capped.
 *
 * Only depth-0 rows: the rolled-up figure already includes descendants, so
 * including children too would double-count in anything the agent totals.
 *
 * The P&L and balance-sheet row types name that figure differently
 * (`rolledUpAmount` vs `rolledUpBalance`), so callers pass an accessor rather
 * than this reaching for a field that exists on only one of them.
 */
function topRows<Row extends { code: string | null; name: string; depth: number }>(
  section: { rows: Row[] },
  rolledUp: (row: Row) => Amountish,
) {
  const ranked = section.rows
    .filter((row) => row.depth === 0)
    .sort((a, b) => Math.abs(Number(rolledUp(b))) - Math.abs(Number(rolledUp(a))));

  return {
    rows: ranked.slice(0, SECTION_ROW_CAP).map((row) => ({
      code: row.code,
      name: row.name,
      amount: money(rolledUp(row)),
    })),
    omittedRows: Math.max(0, ranked.length - SECTION_ROW_CAP),
  };
}

const plRolledUp = (row: PLSection['rows'][number]) => row.rolledUpAmount;
const bsRolledUp = (row: BalanceSheetSection['rows'][number]) => row.rolledUpBalance;

const profitAndLoss: AgentTool = {
  name: 'get_profit_and_loss',
  description:
    'Profit and loss for the current month, quarter, or year to date: revenue total, ' +
    'expense total, net profit, and the largest revenue and expense accounts. ' +
    'Covers POSTED entries only — drafts awaiting approval are excluded.',
  inputSchema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['MTD', 'QTD', 'YTD'],
        description: 'Month, quarter, or year to date. Defaults to MTD.',
      },
    },
  },
  execute: async (input) => {
    const report = await getPLStatementReport(str(input, 'period'), new Date());
    if (!report.ok) return { ok: false, error: report.error };

    const { statement, preset, range, organizationName } = report;
    const revenue = topRows(statement.revenue, plRolledUp);
    const expenses = topRows(statement.expenses, plRolledUp);

    return {
      ok: true,
      data: {
        organizationName,
        period: preset,
        // endExclusive is the start of the next day — report the last day covered.
        rangeStart: range.start.toISOString().slice(0, 10),
        rangeEnd: new Date(range.endExclusive.getTime() - 1).toISOString().slice(0, 10),
        revenueTotal: money(statement.revenue.total),
        expenseTotal: money(statement.expenses.total),
        netProfit: money(statement.netProfit),
        isNetLoss: statement.netProfit.isNegative(),
        topRevenueAccounts: revenue.rows,
        topExpenseAccounts: expenses.rows,
        omittedRevenueAccounts: revenue.omittedRows,
        omittedExpenseAccounts: expenses.omittedRows,
      },
    };
  },
};

const trialBalance: AgentTool = {
  name: 'get_trial_balance',
  description:
    'Trial balance: total debits, total credits, whether the ledger balances, and the ' +
    'largest accounts by absolute balance. Use this when asked whether the books balance.',
  inputSchema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        description:
          'Optional month bucket as "year-monthIndex" where monthIndex is 0-based ' +
          '(e.g. "2026-6" is July 2026). Omit for all periods.',
      },
    },
  },
  execute: async (input) => {
    const report = await getTrialBalanceReport(str(input, 'period'));
    if (!report.ok) return { ok: false, error: report.error };

    const { trialBalance: tb, selectedPeriod, organizationName } = report;
    const ranked = [...tb.rows].sort(
      (a, b) =>
        Math.abs(Number(b.debit) - Number(b.credit)) -
        Math.abs(Number(a.debit) - Number(a.credit)),
    );

    return {
      ok: true,
      data: {
        organizationName,
        period: selectedPeriod,
        totalDebit: money(tb.totalDebit),
        totalCredit: money(tb.totalCredit),
        isBalanced: tb.isBalanced,
        accountCount: tb.rows.length,
        topAccounts: ranked.slice(0, SECTION_ROW_CAP).map((row) => ({
          code: row.code,
          name: row.name,
          type: row.type,
          debit: money(row.debit),
          credit: money(row.credit),
        })),
        omittedAccounts: Math.max(0, ranked.length - SECTION_ROW_CAP),
      },
    };
  },
};

const balanceSheet: AgentTool = {
  name: 'get_balance_sheet',
  description:
    'Balance sheet as at a date: asset, liability, and equity totals, life-to-date ' +
    'earnings, whether the accounting equation holds, and the largest accounts in each section.',
  inputSchema: {
    type: 'object',
    properties: {
      asOf: {
        type: 'string',
        description: 'Date as YYYY-MM-DD. Defaults to today.',
      },
    },
  },
  execute: async (input) => {
    // resolveAsOf falls back to today on anything malformed, so a mis-heard
    // date degrades to "as at today" rather than erroring at the caller.
    const report = await getBalanceSheetReport(resolveAsOf(str(input, 'asOf')));
    if (!report.ok) return { ok: false, error: report.error };

    const { balanceSheet: bs, asOf, organizationName } = report;

    return {
      ok: true,
      data: {
        organizationName,
        asOf,
        assetsTotal: money(bs.assets.total),
        liabilitiesTotal: money(bs.liabilities.total),
        equityTotal: money(bs.equity.total),
        currentPeriodEarnings: money(bs.currentPeriodEarnings),
        balances: bs.balances,
        topAssets: topRows(bs.assets, bsRolledUp).rows,
        topLiabilities: topRows(bs.liabilities, bsRolledUp).rows,
        topEquity: topRows(bs.equity, bsRolledUp).rows,
      },
    };
  },
};

const portfolioMetrics: AgentTool = {
  name: 'get_portfolio_metrics',
  description:
    'Month-to-date portfolio performance across all properties: revenue, net income, ' +
    'net margin, occupancy, ADR, and RevPAR. Use this for "how are we doing" questions.',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => {
    const resolved = await resolveActiveContext();
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const { organizationId, organizationName } = resolved.context;

    try {
      // MetricsService filters by organizationId explicitly, but its queries
      // still cross RLS-protected tables — without the org context the policies
      // fail closed and every metric comes back zero.
      const metrics = await runWithOrgContext(organizationId, () =>
        MetricsService.getPortfolioMetrics(organizationId),
      );

      return {
        ok: true,
        data: {
          organizationName,
          window: 'month to date',
          totalRevenue: metrics.totalRevenue.toFixed(2),
          netIncome: metrics.netIncome.toFixed(2),
          netMarginPercent: metrics.netMargin.toFixed(1),
          occupancyPercent: metrics.occupancy.toFixed(1),
          adr: metrics.adr.toFixed(2),
          revpar: metrics.revpar.toFixed(2),
        },
      };
    } catch (error) {
      console.error('[agent/tools] get_portfolio_metrics failed:', error);
      return { ok: false, error: 'Could not load portfolio metrics. Try again shortly.' };
    }
  },
};

const pendingApprovals: AgentTool = {
  name: 'list_pending_approvals',
  description:
    'Draft journal entries awaiting a four-eyes decision, newest first. Reports how many ' +
    'are waiting and flags the ones the signed-in user made themselves, which they cannot ' +
    'approve. This tool only reads the queue — approving and rejecting happen on /review.',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => {
    const { items } = await fetchDraftReviewQueue({ limit: APPROVAL_CAP });

    return {
      ok: true,
      data: {
        returnedCount: items.length,
        // The queue is capped, so a full page means "at least this many".
        isCapped: items.length === APPROVAL_CAP,
        ownDraftCount: items.filter((item) => item.isOwnDraft).length,
        drafts: items.map((item) => ({
          date: item.date.slice(0, 10),
          memo: item.memo,
          amount: item.amount,
          source: item.source,
          vendor: item.parsed.vendor,
          isOwnDraft: item.isOwnDraft,
        })),
      },
    };
  },
};

/**
 * The complete tool surface exposed to the voice assistant.
 *
 * Adding a write tool here would put a mis-heard number one model decision
 * away from the ledger. Writes belong on the four-eyes path, not in speech.
 */
export const LEDGER_TOOLS: readonly AgentTool[] = [
  profitAndLoss,
  trialBalance,
  balanceSheet,
  portfolioMetrics,
  pendingApprovals,
];

export function findTool(name: string): AgentTool | undefined {
  return LEDGER_TOOLS.find((tool) => tool.name === name);
}

/**
 * Action centre — pure derivation for Raj's "progress + current actions"
 * panel (dashboard home + /sandbox).
 *
 * One glanceable list answering three questions for a non-coder owner:
 * what is WAITING ON ME (urgent), what could move forward (attention), and
 * what did the system just do (info). Everything is injected — counts,
 * events and even `now` — so the ladder is unit-testable with no database
 * and no clock (tests/unit/action-centre.test.ts). All IO lives in
 * src/app/actions/action-centre.actions.ts.
 *
 * Counts only, no money: the panel points at pages that show amounts with
 * proper Decimal handling; repeating figures here would just create a second
 * place for them to be wrong.
 */
import { parkReasonLabel } from './park-reason-labels';

/**
 * How loudly a line speaks, and in what order it appears:
 *  - `urgent`    — Raj personally has to act (approvals);
 *  - `attention` — work is queued up and could move forward;
 *  - `info`      — the system reporting what it already did.
 */
export type ActionPriority = 'urgent' | 'attention' | 'info';

/** One rendered line of the panel: a priority, plain English, optional link. */
export interface ActionItem {
  priority: ActionPriority;
  /** Complete sentence/phrase for a non-coder — no jargon, no raw ids. */
  text: string;
  /** Where the line leads, when there is somewhere useful to go. */
  href?: string;
}

/**
 * Minimal structural slice of OcrStagingSummary — keeps this module free of
 * ocr-bridge.deps (which imports prisma).
 *
 * Deliberately carries no `unavailableReason`: WHY the pile could not be read
 * decides whether the whole panel degrades, which is the caller's judgement
 * (see fetchActionCentre / isStagingOutage). All this pure layer has to know
 * is that unavailable counts are meaningless and must not be rendered.
 */
export interface ActionCentreStaging {
  available: boolean;
  importable: number;
  parked: { reason: string; count: number }[];
}

/** One EvidenceLog row as the panel consumes it (payload is untrusted Json). */
export interface ActionCentreEvent {
  eventType: string;
  createdAt: Date;
  description: string;
  payload: unknown;
}

/**
 * Everything deriveActionItems is allowed to look at. Injected wholesale (the
 * clock included) so the panel's wording and ordering are testable without a
 * database and without real time passing.
 */
export interface ActionCentreInputs {
  /** DRAFT journal entries sitting in the four-eyes queue for this org. */
  draftsAwaitingApproval: number;
  staging: ActionCentreStaging;
  /** Newest first; filtered again here by type and the 24h window. */
  recentEvents: ActionCentreEvent[];
  /** Injected so relative times are deterministic under test. */
  now: Date;
}

/**
 * Evidence event types the panel narrates. Shared with the server action's
 * query filter so the DB slice and the pure filter can never drift.
 * ZIP_CHAT_INGESTED is deliberately absent — per-file evidence noise, not an
 * activity headline.
 */
export const ACTION_EVENT_TYPES = [
  'ZIP_INGEST_COMPLETED',
  'STATEMENT_INGEST_COMPLETED',
  'JOURNAL_DRAFT_APPROVED',
  'JOURNAL_DRAFT_REJECTED',
  'ACTION_INTENT_APPROVED',
  'ACTION_INTENT_REJECTED',
] as const;

/** Only activity newer than this is worth narrating. */
export const RECENT_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Panel line cap — urgent/attention always survive; info lines fill the rest. */
export const MAX_ACTION_ITEMS = 6;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * "just now" / "45 minutes ago" / "2 hours ago" / "3 days ago" — coarse on
 * purpose, because the panel is glanced at, not read. Both ends are supplied
 * so the output is deterministic; a `then` in the future clamps to "just now"
 * rather than printing a negative age.
 */
export function formatRelativeTime(then: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - then.getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return plural(minutes, 'minute') + ' ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour') + ' ago';
  return plural(Math.floor(hours / 24), 'day') + ' ago';
}

/** payload.{key} as a non-negative count, or null when absent/malformed. */
function payloadCount(payload: unknown, key: string): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * One plain-English activity sentence per event. Ingest events read their
 * counts from the evidence payload defensively — a missing/foreign payload
 * falls back to the row's own description rather than inventing numbers.
 */
function describeEvent(event: ActionCentreEvent): string {
  switch (event.eventType) {
    case 'ZIP_INGEST_COMPLETED': {
      const created = payloadCount(event.payload, 'created');
      const deduped = payloadCount(event.payload, 'deduped');
      if (created === null || deduped === null) return event.description;
      return `${plural(created, 'receipt')} uploaded, ${plural(deduped, 'duplicate')} skipped`;
    }
    case 'STATEMENT_INGEST_COMPLETED': {
      const created = payloadCount(event.payload, 'created');
      const deduped = payloadCount(event.payload, 'deduped');
      if (created === null || deduped === null) return event.description;
      return `${plural(created, 'bank transaction')} imported, ${plural(deduped, 'duplicate')} skipped`;
    }
    case 'JOURNAL_DRAFT_APPROVED':
      return 'an entry was approved into the books';
    case 'JOURNAL_DRAFT_REJECTED':
      return 'a draft entry was rejected';
    case 'ACTION_INTENT_APPROVED':
      return 'an action was approved';
    case 'ACTION_INTENT_REJECTED':
      return 'an action was rejected';
    default:
      return event.description;
  }
}

/**
 * The priority ladder, top first:
 *   1. drafts awaiting approval        → urgent, links to the consensus queue
 *   2. staged receipts ready to import → attention
 *   3. parked receipts by reason       → attention (shared park-reason wording)
 *   4. recent (24h) ingest/approval activity → info with relative time
 *   5. nothing at all                  → one calm all-caught-up line
 */
export function deriveActionItems(inputs: ActionCentreInputs): ActionItem[] {
  const items: ActionItem[] = [];

  if (inputs.draftsAwaitingApproval > 0) {
    const n = inputs.draftsAwaitingApproval;
    items.push({
      priority: 'urgent',
      text: n === 1 ? '1 entry awaits your approval' : `${n} entries await your approval`,
      href: '/sandbox',
    });
  }

  // Staging counts are only meaningful when the summary actually ran — an
  // unavailable pile must not fabricate attention items from stale zeros.
  if (inputs.staging.available) {
    if (inputs.staging.importable > 0) {
      items.push({
        priority: 'attention',
        text: `${plural(inputs.staging.importable, 'receipt')} staged, ready to feed into books`,
        href: '/sandbox',
      });
    }
    const parkedTotal = inputs.staging.parked.reduce((acc, p) => acc + p.count, 0);
    if (parkedTotal > 0) {
      const reasons = inputs.staging.parked
        .map((p) => `${p.count} ${parkReasonLabel(p.reason)}`)
        .join(', ');
      items.push({
        priority: 'attention',
        text: `${plural(parkedTotal, 'receipt')} parked: ${reasons}`,
      });
    }
  }

  const knownTypes = new Set<string>(ACTION_EVENT_TYPES);
  const cutoff = inputs.now.getTime() - RECENT_EVENT_WINDOW_MS;
  for (const event of inputs.recentEvents) {
    if (items.length >= MAX_ACTION_ITEMS) break;
    if (!knownTypes.has(event.eventType)) continue;
    if (event.createdAt.getTime() < cutoff) continue;
    items.push({
      priority: 'info',
      text: `${formatRelativeTime(event.createdAt, inputs.now)}: ${describeEvent(event)}`,
    });
  }

  if (items.length === 0) {
    return [{ priority: 'info', text: 'All caught up — nothing needs you.' }];
  }
  return items.slice(0, MAX_ACTION_ITEMS);
}

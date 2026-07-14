import type { ZipIngestReport } from './zip-ingest';

export type ZipIngestSummaryTone = 'success' | 'neutral' | 'warning' | 'error';

export interface ZipIngestSummary {
  tone: ZipIngestSummaryTone;
  headline: string;
  details: string[];
}

const MAX_SKIPPED_LISTED = 10;

/**
 * Turn a raw ZipIngestReport into UI-ready text. Pure and DOM-free so it is
 * testable without a component-test harness (none exists in this repo yet).
 */
export function summarizeZipIngestReport(report: ZipIngestReport): ZipIngestSummary {
  const { created, deduped, failures, skipped, chatFiles } = report;

  let tone: ZipIngestSummaryTone;
  let headline: string;

  if (created > 0 && failures.length === 0) {
    tone = 'success';
    headline = `${created} draft ${created === 1 ? 'entry' : 'entries'} created — queued for 4-eyes review.`;
  } else if (created > 0 && failures.length > 0) {
    tone = 'warning';
    headline = `${created} draft ${created === 1 ? 'entry' : 'entries'} created, but ${failures.length} ${failures.length === 1 ? 'item' : 'items'} failed.`;
  } else if (created === 0 && failures.length > 0) {
    tone = 'error';
    headline = `Nothing was imported — ${failures.length} ${failures.length === 1 ? 'item' : 'items'} failed.`;
  } else if (created === 0 && deduped > 0) {
    tone = 'neutral';
    headline = `Nothing new — all ${deduped} matching receipt${deduped === 1 ? '' : 's'} ${deduped === 1 ? 'was' : 'were'} already imported.`;
  } else {
    tone = 'neutral';
    headline = 'No receipts or chat files were found in this archive.';
  }

  const details: string[] = [];

  for (const failure of failures) {
    details.push(`${failure.name}: ${failure.stage} failed — ${failure.error}`);
  }

  if (skipped.length > 0) {
    const shown = skipped.slice(0, MAX_SKIPPED_LISTED);
    for (const s of shown) {
      details.push(`Skipped ${s.name}: ${s.reason}`);
    }
    if (skipped.length > MAX_SKIPPED_LISTED) {
      details.push(`…and ${skipped.length - MAX_SKIPPED_LISTED} more skipped entries.`);
    }
  }

  for (const chat of chatFiles) {
    details.push(
      `Chat transcript "${chat.name}": ${chat.messageCount} message${chat.messageCount === 1 ? '' : 's'} from ${chat.participants.length} participant${chat.participants.length === 1 ? '' : 's'}.`,
    );
  }

  return { tone, headline, details };
}

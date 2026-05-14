'use server';

import { AutomationService, type AutomationResult } from '../../lib/automation.service';
import { resolveActiveContext } from '@/lib/auth-context';

export interface ProcessReceiptInput {
  propertyId: string;
  imageBase64: string;
  source?: 'WEB' | 'MOBILE';
}

export type ProcessReceiptResult =
  | { success: true; data: AutomationResult }
  | { success: false; error: string };

/**
 * Processes an uploaded receipt into a ledger entry.
 *
 * The organisation is resolved from the signed-in user's session — NOT
 * from client input. Previously `organizationId` was a request field, so
 * a crafted POST could book an expense against any tenant. `propertyId`
 * is still client-supplied (the user picks a property) but
 * AutomationService.processReceipt validates it belongs to the resolved
 * organisation before posting.
 */
export async function processReceiptAction(
  input: ProcessReceiptInput,
): Promise<ProcessReceiptResult> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return { success: false, error: resolved.error };
  }

  try {
    const result = await AutomationService.processReceipt(
      resolved.context.organizationId,
      input.propertyId,
      input.imageBase64,
      { source: input.source ?? 'WEB' },
    );
    return { success: true, data: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Receipt processing failed';
    console.error('[receipt.actions] processReceiptAction failed:', error);
    return { success: false, error: message };
  }
}

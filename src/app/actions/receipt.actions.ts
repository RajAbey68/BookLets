'use server';

import { AutomationService, type AutomationResult } from '../../lib/automation.service';

export interface ProcessReceiptInput {
  organizationId: string;
  propertyId: string;
  imageBase64: string;
  source?: 'WEB' | 'MOBILE';
}

export type ProcessReceiptResult =
  | { success: true; data: AutomationResult }
  | { success: false; error: string };

export async function processReceiptAction(
  input: ProcessReceiptInput,
): Promise<ProcessReceiptResult> {
  try {
    const result = await AutomationService.processReceipt(
      input.organizationId,
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

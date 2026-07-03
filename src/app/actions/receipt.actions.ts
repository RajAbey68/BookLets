'use server';

import { AutomationService, type AutomationResult } from '../../lib/automation.service';
import { resolveActiveContext } from '@/lib/auth-context';
import {
  assertPayloadSize,
  assertImageMagicBytes,
  receiptRateLimiter,
  UploadGuardError,
} from '@/lib/upload-guard';

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
 *
 * RAJ-456: before AutomationService is invoked, the payload passes three
 * server-side guards (see src/lib/upload-guard.ts) — size cap (5 MB
 * decoded, estimated without a full decode), real image magic-byte
 * validation (JPEG/PNG/HEIC/WebP) and a per-organisation in-memory rate
 * limit (10 receipts/min, per-process only).
 */
export async function processReceiptAction(
  input: ProcessReceiptInput,
): Promise<ProcessReceiptResult> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return { success: false, error: resolved.error };
  }

  try {
    assertPayloadSize(input.imageBase64);
    assertImageMagicBytes(input.imageBase64);
    if (!receiptRateLimiter.tryConsume(resolved.context.organizationId)) {
      console.warn(
        `[receipt.actions] upload rejected: RATE_LIMITED org=${resolved.context.organizationId}`,
      );
      return {
        success: false,
        error: 'Too many receipts uploaded in the last minute. Please wait a moment and try again.',
      };
    }
  } catch (error) {
    if (error instanceof UploadGuardError) {
      console.warn(
        `[receipt.actions] upload rejected: ${error.code} org=${resolved.context.organizationId} payloadChars=${input.imageBase64?.length ?? 0}`,
      );
      return { success: false, error: error.message };
    }
    throw error;
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

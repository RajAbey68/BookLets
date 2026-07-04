/**
 * RAJ-513 [Sprint 0] — the single write path onto the 4-eyes ActionIntentQueue.
 *
 * ActionIntentQueue.organizationId is NOT NULL at the DB since the RAJ-513
 * fix round (20260704_action_intent_org_not_null — safe: prod table verified
 * empty on 2026-07-04). This service remains the single write path and the
 * first line of defence: an intent without a real organizationId (including
 * whitespace-only, which the DB would still accept) is rejected with a clear
 * error before anything is written. An org-less intent would be filtered out
 * of /approvals forever — invisible and undecidable — a silent 4-eyes bypass
 * by omission.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/** Thrown when an intent is enqueued without a tenant scope. */
export class MissingOrganizationError extends Error {
  constructor() {
    super(
      'ActionIntent rejected: organizationId is required. An intent without a tenant scope ' +
        'is invisible on /approvals and can never be decided (4-eyes bypass by omission).'
    );
    this.name = 'MissingOrganizationError';
  }
}

/**
 * Producer-facing input. Deliberately narrow: status, checkerIdentity,
 * approvedAt and executedAt are decision-side fields owned by the approval
 * flow (approval.actions) — a maker can never pre-decide its own intent.
 */
export interface ActionIntentInput {
  organizationId: string;
  action: string;
  payload: Prisma.InputJsonValue;
  makerIdentity: string;
  confidence: number;
}

export class ActionIntentService {
  /**
   * Guard: organizationId must be a non-empty, non-whitespace string.
   * Mirrors the identity normalisation stance in approval.service — blank
   * is treated the same as absent.
   */
  static assertOrganizationScope(
    organizationId: string | null | undefined
  ): asserts organizationId is string {
    if (!organizationId || organizationId.trim() === '') {
      throw new MissingOrganizationError();
    }
  }

  /** Enqueue a PENDING intent for 4-eyes review. Rejects org-less intents. */
  static async enqueue(input: ActionIntentInput) {
    this.assertOrganizationScope(input.organizationId);

    // Explicit field list — never spread the caller's object, so decision
    // fields (status/checkerIdentity/...) can not be smuggled in.
    return prisma.actionIntentQueue.create({
      data: {
        organizationId: input.organizationId,
        action: input.action,
        payload: input.payload,
        makerIdentity: input.makerIdentity,
        confidence: input.confidence,
      },
    });
  }
}

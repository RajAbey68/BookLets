/**
 * RAJ-513 [Sprint 0] — the single write path onto the 4-eyes ActionIntentQueue.
 *
 * ActionIntentQueue.organizationId is nullable at the DB level only because
 * the column was retrofitted onto an empty table (add-only migration rule —
 * see 20260703_action_intent_org_scope). The tenant invariant is enforced
 * HERE instead: every producer must enqueue through this service, and an
 * intent without a real organizationId is rejected before anything is
 * written. An org-less intent would be filtered out of /approvals forever —
 * invisible and undecidable — which is a silent 4-eyes bypass by omission.
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

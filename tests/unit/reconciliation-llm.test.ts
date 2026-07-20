/**
 * DeepSeek adjudicator for ambiguous reconciliation rows.
 *
 * Contract under test:
 *  - Only ever *selects among* deterministic candidates — a booking id outside
 *    the candidate set (hallucination) is rejected → null decision.
 *  - Any transport error, non-200, or malformed JSON → null decision (row
 *    stays an exception; the LLM can never break the run).
 *  - No API key → null decision without any network call.
 *  - fetch is injected; tests never touch the network.
 */
import { describe, it, expect, vi } from 'vitest';
import { adjudicateAmbiguity } from '../../src/lib/reconciliation-llm';
import type { Ambiguity } from '../../src/lib/reconciliation';

const ambiguity: Ambiguity = {
  payout: { id: 'po-1', date: new Date('2026-07-01T00:00:00Z'), amount: '1250.00', reference: 'HSBC-771' },
  candidates: [
    { id: 'bk-1', checkOut: new Date('2026-06-30T00:00:00Z'), totalAmount: '1250.00' },
    { id: 'bk-2', checkOut: new Date('2026-07-02T00:00:00Z'), totalAmount: '1250.00' },
  ],
};

function deepseekResponse(content: string, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

describe('adjudicateAmbiguity', () => {
  it('returns the chosen booking when DeepSeek picks a valid candidate', async () => {
    const fetchImpl = deepseekResponse(JSON.stringify({ bookingId: 'bk-2', confidence: 0.9, rationale: 'closest date' }));
    const decision = await adjudicateAmbiguity(ambiguity, { apiKey: 'k', fetchImpl });
    expect(decision).toEqual({ bookingId: 'bk-2', confidence: 0.9, rationale: 'closest date' });
  });

  it('sends the payout and candidate facts to the DeepSeek chat endpoint', async () => {
    const fetchImpl = deepseekResponse(JSON.stringify({ bookingId: 'bk-1', confidence: 0.8, rationale: 'r' }));
    await adjudicateAmbiguity(ambiguity, { apiKey: 'secret-key', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('api.deepseek.com');
    expect(init.headers.Authorization).toBe('Bearer secret-key');
    const body = JSON.parse(init.body);
    expect(JSON.stringify(body)).toContain('po-1');
    expect(JSON.stringify(body)).toContain('bk-1');
    expect(JSON.stringify(body)).toContain('bk-2');
  });

  it('rejects a hallucinated booking id outside the candidate set', async () => {
    const fetchImpl = deepseekResponse(JSON.stringify({ bookingId: 'bk-999', confidence: 0.99, rationale: 'x' }));
    expect(await adjudicateAmbiguity(ambiguity, { apiKey: 'k', fetchImpl })).toBeNull();
  });

  it('honours an explicit null decision from the model', async () => {
    const fetchImpl = deepseekResponse(JSON.stringify({ bookingId: null, confidence: 0.2, rationale: 'cannot tell' }));
    expect(await adjudicateAmbiguity(ambiguity, { apiKey: 'k', fetchImpl })).toBeNull();
  });

  it('returns null on non-200 responses', async () => {
    const fetchImpl = deepseekResponse('irrelevant', 429);
    expect(await adjudicateAmbiguity(ambiguity, { apiKey: 'k', fetchImpl })).toBeNull();
  });

  it('returns null on malformed model output', async () => {
    const fetchImpl = deepseekResponse('sorry, as an AI I cannot...');
    expect(await adjudicateAmbiguity(ambiguity, { apiKey: 'k', fetchImpl })).toBeNull();
  });

  it('returns null on a transport error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    expect(await adjudicateAmbiguity(ambiguity, { apiKey: 'k', fetchImpl })).toBeNull();
  });

  it('omits the raw payout reference from the prompt by default (data minimisation)', async () => {
    const fetchImpl = deepseekResponse(JSON.stringify({ bookingId: 'bk-1', confidence: 0.8, rationale: 'r' }));
    await adjudicateAmbiguity(ambiguity, { apiKey: 'k', fetchImpl });
    const body = fetchImpl.mock.calls[0][1].body as string;
    expect(body).not.toContain('HSBC-771');
  });

  it('includes the reference only when allowReferences is explicitly enabled', async () => {
    const fetchImpl = deepseekResponse(JSON.stringify({ bookingId: 'bk-1', confidence: 0.8, rationale: 'r' }));
    await adjudicateAmbiguity(ambiguity, { apiKey: 'k', fetchImpl, allowReferences: true });
    const body = fetchImpl.mock.calls[0][1].body as string;
    expect(body).toContain('HSBC-771');
  });

  it('skips the network entirely when no API key is configured', async () => {
    const fetchImpl = vi.fn();
    expect(await adjudicateAmbiguity(ambiguity, { apiKey: undefined, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

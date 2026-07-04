import type { Ambiguity } from './reconciliation';

/**
 * DeepSeek adjudicator for ambiguous reconciliation rows (P7 cost tiering:
 * deterministic first, DeepSeek only for the leftovers, direct REST).
 *
 * Fail-safe by design: the model may only SELECT among the deterministic
 * candidates or decline. Any error, malformed output, or hallucinated id
 * yields a null decision and the row stays an exception for a human.
 * The API key is injected via env/Keychain by the caller — never stored here.
 */

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';
const MAX_TOKENS = 300;

export interface AdjudicationDecision {
  bookingId: string;
  confidence: number;
  rationale: string;
}

export interface AdjudicateOptions {
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Data minimisation: bank references may carry guest-identifying fragments,
   * so they are withheld from the external model unless explicitly enabled
   * (RECON_ALLOW_REFERENCES=true).
   */
  allowReferences?: boolean;
}

function buildPrompt(ambiguity: Ambiguity, allowReferences: boolean): string {
  const { payout, candidates } = ambiguity;
  const reference = allowReferences ? (payout.reference ?? 'none') : 'withheld';
  return [
    'You are reconciling a villa bank payout against candidate bookings.',
    'All candidates already have the exact same amount as the payout, so decide',
    'ONLY on settlement-date proximity and reference hints. If you cannot decide',
    'with confidence >= 0.7, return bookingId null.',
    '',
    `Payout: id=${payout.id} date=${payout.date.toISOString().slice(0, 10)} ` +
      `amount=${payout.amount} reference=${reference}`,
    'Candidates:',
    ...candidates.map(
      (c) => `- id=${c.id} checkOut=${c.checkOut.toISOString().slice(0, 10)} amount=${c.totalAmount}`
    ),
    '',
    'Respond with ONLY a JSON object, no prose:',
    '{"bookingId": "<candidate id or null>", "confidence": <0..1>, "rationale": "<one sentence>"}',
  ].join('\n');
}

/**
 * Ask DeepSeek to pick one candidate booking for an ambiguous payout.
 * Returns null (leave as exception) on: missing key, transport error,
 * non-200, unparseable output, id not in the candidate set, or an explicit
 * null decision from the model.
 */
export async function adjudicateAmbiguity(
  ambiguity: Ambiguity,
  opts: AdjudicateOptions
): Promise<AdjudicationDecision | null> {
  const { apiKey, fetchImpl = fetch, timeoutMs = 30_000, allowReferences = false } = opts;
  if (!apiKey) return null;

  try {
    const response = await fetchImpl(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        messages: [{ role: 'user', content: buildPrompt(ambiguity, allowReferences) }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as {
      bookingId?: string | null;
      confidence?: number;
      rationale?: string;
    };

    if (typeof parsed.bookingId !== 'string') return null;
    const isCandidate = ambiguity.candidates.some((c) => c.id === parsed.bookingId);
    if (!isCandidate) return null;

    return {
      bookingId: parsed.bookingId,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    };
  } catch {
    // Transport error, timeout, or non-JSON model output — fail safe.
    return null;
  }
}

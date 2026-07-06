/**
 * BookLets OCR client — calls the shared OCR microservice.
 *
 * Instead of calling the Gemini API directly, this module POSTs to the
 * shared OCR microservice at OCR_MICROSERVICE_URL (default http://localhost:3099).
 * Falls back to SymbiOS if the microservice is unreachable.
 *
 * Environment:
 *   OCR_MICROSERVICE_URL — URL of the OCR microservice (default: http://localhost:3099)
 *   GEMINI_API_KEY — fallback if microservice is unreachable (loaded from env)
 */

const OCR_MICROSERVICE_URL =
  process.env.OCR_MICROSERVICE_URL || 'http://localhost:3099';
const OCR_TIMEOUT_MS = (() => {
  const raw = process.env.OCR_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
})();

export interface GeminiExtraction {
  vendorName: string;
  date: string; // ISO-8601 date string, e.g. "2025-03-15" or "" if not visible
  totalAmount: number;
  categorySuggestion: string;
  confidence: number; // 0–1
}

export interface GeminiOcrResult {
  extraction: GeminiExtraction;
}

/**
 * Extract receipt data from a base64-encoded image via the OCR microservice.
 *
 * @param imageBase64 - Base64-encoded image data (with or without data URI prefix)
 * @returns The extraction result
 * @throws Error if the microservice is unreachable or returns an error
 */
export async function extractReceipt(
  imageBase64: string
): Promise<GeminiOcrResult> {
  // Try the OCR microservice first
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);

    const response = await fetch(`${OCR_MICROSERVICE_URL}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64,
        mode: 'receipt',
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `OCR microservice error: ${response.status} ${response.statusText}${
          errorText ? ` — ${errorText.slice(0, 500)}` : ''
        }`
      );
    }

    const data = await response.json();

    // The microservice returns { text: string, confidence: number }
    // For receipt mode, text is a JSON string matching GeminiExtraction
    let extraction: GeminiExtraction;
    try {
      extraction = JSON.parse(data.text);
    } catch {
      // If it's not valid JSON, create a default extraction
      extraction = {
        vendorName: 'Unknown',
        date: '',
        totalAmount: 0,
        categorySuggestion: 'Other',
        confidence: data.confidence || 0,
      };
    }

    // Validate and clean the extraction
    validateExtraction(extraction);

    return { extraction };
  } catch (err) {
    // Microservice failed — fall back to SymbiOS
    console.warn(
      'OCR microservice unreachable, falling back to SymbiOS:',
      err instanceof Error ? err.message : String(err)
    );
    return fallbackToSymbios(imageBase64);
  }
}

/**
 * Fallback: Call SymbiOS /api/v1/automation/extract-receipt.
 */
async function fallbackToSymbios(
  imageBase64: string
): Promise<GeminiOcrResult> {
  const SYMBIOS_URL = process.env.SYMBIOS_URL || 'https://api.symbios.ai';
  const SYMBIOS_API_KEY = process.env.SYMBIOS_API_KEY || '';

  if (!SYMBIOS_API_KEY) {
    throw new Error(
      'OCR: Microservice unreachable and no SymbiOS API key configured.'
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');

    const response = await fetch(
      `${SYMBIOS_URL}/api/v1/automation/extract-receipt`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SYMBIOS_API_KEY}`,
        },
        body: JSON.stringify({ image: cleanBase64 }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `SymbiOS API Error: ${response.status} ${response.statusText}${
          errorText ? ` — ${errorText.slice(0, 500)}` : ''
        }`
      );
    }

    const data = await response.json();
    return data as GeminiOcrResult;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Validate the parsed extraction fields.
 * Date is allowed to be null/empty when the image doesn't have one.
 */
function validateExtraction(extraction: GeminiExtraction): void {
  if (!extraction.vendorName || typeof extraction.vendorName !== 'string') {
    extraction.vendorName = 'Unknown';
  }

  // Fix #1: Date is allowed to be null/empty when image doesn't have one.
  // Only normalize if it's a non-empty string that isn't YYYY-MM-DD format.
  if (
    extraction.date &&
    typeof extraction.date === 'string' &&
    !/^\d{4}-\d{2}-\d{2}$/.test(extraction.date)
  ) {
    const parsed = new Date(extraction.date);
    if (!isNaN(parsed.getTime())) {
      extraction.date = parsed.toISOString().slice(0, 10);
    } else {
      // Can't parse — empty string is the signal "date not found"
      extraction.date = '';
    }
  }

  if (typeof extraction.totalAmount !== 'number' || isNaN(extraction.totalAmount)) {
    extraction.totalAmount = 0;
  }

  const validCategories = [
    'Groceries', 'Dining', 'Utilities', 'Transport',
    'Office Supplies', 'Accommodation', 'Healthcare', 'Entertainment', 'Other',
  ];

  if (
    !extraction.categorySuggestion ||
    !validCategories.includes(extraction.categorySuggestion)
  ) {
    extraction.categorySuggestion = 'Other';
  }

  if (typeof extraction.confidence !== 'number' || isNaN(extraction.confidence)) {
    extraction.confidence = 0;
  }

  // Clamp confidence to [0, 1]
  extraction.confidence = Math.max(0, Math.min(1, extraction.confidence));
}

/**
 * Gemini Flash Vision OCR — receipt text extraction via Google Gemini API.
 *
 * Replaces the SymbiOS `/api/v1/automation/extract-receipt` endpoint
 * with a direct Google Gemini Flash Vision call. Returns the same
 * shape so the caller is transparently swapped.
 *
 * Environment:
 *   GEMINI_API_KEY — required, loaded from macOS Keychain service "gemini-api"
 *
 * Supports English and Sinhala mixed text on receipts.
 */

const GEMINI_MODEL = process.env.GEMINI_OCR_MODEL || 'gemini-1.5-flash';
const GEMINI_API_BASE =
  process.env.GEMINI_API_BASE ||
  'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_TIMEOUT_MS = (() => {
  const raw = process.env.GEMINI_OCR_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
})();

export interface GeminiExtraction {
  vendorName: string;
  date: string; // ISO-8601 date string, e.g. "2025-03-15"
  totalAmount: number;
  categorySuggestion: string;
  confidence: number; // 0–1
}

export interface GeminiOcrResult {
  extraction: GeminiExtraction;
}

/**
 * Shared extraction prompt — instructs the model to handle Sinhala+English
 * mixed receipts and return a structured JSON object.
 */
const EXTRACTION_PROMPT = `You are a receipt OCR assistant for BookLets, an accounting application used in Sri Lanka.

Extract the following fields from the receipt image and return ONLY valid JSON (no markdown fences, no extra text):

{
  "vendorName": "Store or business name (transliterate Sinhala names to Latin characters if needed)",
  "date": "YYYY-MM-DD format date from the receipt",
  "totalAmount": 0.00,
  "categorySuggestion": "One of: Groceries, Dining, Utilities, Transport, Office Supplies, Accommodation, Healthcare, Entertainment, Other",
  "confidence": 0.95
}

Rules:
- Receipts may contain a mix of English and Sinhala text. Extract ALL text you can read.
- If a vendor name is in Sinhala, transliterate it to Latin characters.
- If the date is ambiguous, use the most prominent date on the receipt.
- totalAmount must be a number (not a string).
- confidence should reflect how certain you are about the overall extraction (0.0 = unsure, 1.0 = completely certain).
- If you cannot read any text, set confidence to 0 and vendorName to "Unknown".
- categorySuggestion must be exactly one of the listed categories.`;

/**
 * Extract receipt data from a base64-encoded image using Gemini Flash Vision.
 *
 * @param imageBase64 - Base64-encoded image data (without data URI prefix)
 * @returns The extraction result matching the SymbiOS response shape
 * @throws Error if the API key is missing, the request fails, or parsing fails
 */
export async function extractReceipt(
  imageBase64: string
): Promise<GeminiOcrResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Gemini OCR: GEMINI_API_KEY is not set in environment variables.'
    );
  }

  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // Strip data URI prefix if present (the caller might pass raw base64 or a data URL)
  const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');

  // Detect MIME type from the base64 header bytes. The Gemini API needs a valid
  // mimeType. Since we're dealing with receipt images, common types are jpeg/png/webp.
  const mimeType = sniffMimeType(cleanBase64);

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: EXTRACTION_PROMPT },
          {
            inlineData: {
              mimeType,
              data: cleanBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1, // low temperature for deterministic extraction
      maxOutputTokens: 512,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Gemini OCR API Error: ${response.status} ${response.statusText}${
          errorText ? ` — ${errorText.slice(0, 500)}` : ''
        }`
      );
    }

    const data = await response.json();

    // Extract the model's text response from the Gemini response format
    const textResponse =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!textResponse) {
      // Check for blocked content
      const blockReason = data?.promptFeedback?.blockReason;
      if (blockReason) {
        throw new Error(
          `Gemini OCR: Content blocked — ${blockReason}`
        );
      }
      throw new Error(
        'Gemini OCR: Empty response — no text returned from model.'
      );
    }

    // Parse the JSON from the model's response (strip any markdown fences)
    const cleanedJson = cleanJsonResponse(textResponse);
    const extraction: GeminiExtraction = JSON.parse(cleanedJson);

    // Validate the fields
    validateExtraction(extraction);

    return { extraction };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(
        `Gemini OCR: Request timed out after ${GEMINI_TIMEOUT_MS}ms.`
      );
    }
    // Re-throw errors that are already our Error type; wrap others
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(`Gemini OCR: Unexpected error — ${String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Sniff MIME type from base64-encoded image data by inspecting the first few
 * decoded bytes. Defaults to image/jpeg which Gemini handles fine.
 */
function sniffMimeType(base64: string): string {
  // Decode just enough bytes to check the magic number
  const raw = atob(base64.slice(0, 30));
  const byte0 = raw.charCodeAt(0);
  const byte1 = raw.charCodeAt(1);

  if (byte0 === 0xff && byte1 === 0xd8) return 'image/jpeg';
  if (byte0 === 0x89 && byte1 === 0x50) return 'image/png';
  // WEBP starts with "RIFF" + 4 bytes + "WEBP"
  if (byte0 === 0x52 && raw.slice(0, 4) === 'RIFF') return 'image/webp';
  // HEIC/HEIF
  if (byte0 === 0x00 && byte1 === 0x00) return 'image/heic';

  return 'image/jpeg'; // safe default
}

/**
 * Strip markdown fences or extra whitespace from the model's JSON response.
 */
function cleanJsonResponse(text: string): string {
  let cleaned = text.trim();

  // Remove markdown code fences
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }

  return cleaned.trim();
}

/**
 * Validate the parsed extraction fields, filling in sensible defaults for
 * missing fields and rejecting clearly invalid values.
 */
function validateExtraction(extraction: GeminiExtraction): void {
  if (!extraction.vendorName || typeof extraction.vendorName !== 'string') {
    extraction.vendorName = 'Unknown';
  }

  if (
    !extraction.date ||
    typeof extraction.date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(extraction.date)
  ) {
    // Fallback: if it's a date-like string but not YYYY-MM-DD, try to normalize
    if (typeof extraction.date === 'string') {
      const parsed = new Date(extraction.date);
      if (!isNaN(parsed.getTime())) {
        extraction.date = parsed.toISOString().slice(0, 10);
      } else {
        extraction.date = new Date().toISOString().slice(0, 10);
      }
    } else {
      extraction.date = new Date().toISOString().slice(0, 10);
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

/**
 * S1b — POST /api/ingest/ocr-bridge authorization + input guards.
 *
 * The bridge imports an ORG-LESS staging pool, so the route carries the whole
 * tenancy defence (see src/lib/ocr-bridge.deps.ts):
 *   401  unauthenticated;
 *   403  authenticated but not OWNER/ADMIN (role gate);
 *   503  OCR_BRIDGE_ORG_ID unset — fail closed, never guess an org;
 *   403  caller's organization ≠ OCR_BRIDGE_ORG_ID (org binding);
 *   400  body is valid JSON but not a plain object (null/array/primitive).
 *
 * Mocked-module tests in the style of approval-actions.test.ts — no database;
 * runOcrBridgeImport is stubbed and must only be reached by authorized calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORG = 'org-bridge';

const summary = {
  posted: 1,
  skipped_existing: 0,
  failed: [],
  parked: [],
  remaining: 0,
};

interface SetupOverrides {
  unauthenticated?: boolean;
  role?: string;
  organizationId?: string;
}

function setup(overrides: SetupOverrides = {}) {
  const runOcrBridgeImport = vi.fn().mockResolvedValue(summary);
  vi.doMock('../../src/lib/ocr-bridge.deps', () => ({ runOcrBridgeImport }));
  vi.doMock('../../src/lib/auth-context', () => ({
    resolveActiveContext: vi.fn().mockResolvedValue(
      overrides.unauthenticated
        ? { ok: false, error: 'Not authenticated. Sign in to continue.' }
        : {
            ok: true,
            context: {
              organizationId: overrides.organizationId ?? ORG,
              organizationName: 'Bridge Org',
              userId: 'user-1',
              role: overrides.role ?? 'OWNER',
            },
          },
    ),
  }));
  return { runOcrBridgeImport };
}

async function post(body?: string) {
  const { POST } = await import('../../src/app/api/ingest/ocr-bridge/route');
  return POST(
    new Request('http://localhost/api/ingest/ocr-bridge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('OCR_BRIDGE_ORG_ID', ORG);
});

afterEach(() => vi.unstubAllEnvs());

describe('POST /api/ingest/ocr-bridge — authorization', () => {
  it('returns 401 when unauthenticated', async () => {
    const { runOcrBridgeImport } = setup({ unauthenticated: true });
    const res = await post();
    expect(res.status).toBe(401);
    expect(runOcrBridgeImport).not.toHaveBeenCalled();
  });

  it('returns 403 for authenticated members without OWNER/ADMIN role', async () => {
    for (const role of ['BOOKKEEPER', 'ACCOUNTANT', 'VIEWER', 'owner', '']) {
      vi.resetModules();
      const { runOcrBridgeImport } = setup({ role });
      const res = await post();
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/OWNER or ADMIN/);
      expect(runOcrBridgeImport).not.toHaveBeenCalled();
    }
  });

  it('allows OWNER and ADMIN roles through the gate', async () => {
    for (const role of ['OWNER', 'ADMIN']) {
      vi.resetModules();
      const { runOcrBridgeImport } = setup({ role });
      const res = await post();
      expect(res.status).toBe(200);
      expect(runOcrBridgeImport).toHaveBeenCalledWith(ORG, expect.any(Number));
    }
  });

  it('fails closed with 503 when OCR_BRIDGE_ORG_ID is unset', async () => {
    vi.stubEnv('OCR_BRIDGE_ORG_ID', '');
    const { runOcrBridgeImport } = setup();
    const res = await post();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(
      'OCR bridge is not configured (OCR_BRIDGE_ORG_ID unset).',
    );
    expect(runOcrBridgeImport).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller's organization is not the configured bridge org", async () => {
    const { runOcrBridgeImport } = setup({ organizationId: 'org-other' });
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not bound to your organization/);
    expect(runOcrBridgeImport).not.toHaveBeenCalled();
  });
});

describe('POST /api/ingest/ocr-bridge — body validation', () => {
  it('returns 400 for a JSON null body instead of an unstructured 500', async () => {
    const { runOcrBridgeImport } = setup();
    const res = await post('null');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Request body must be a JSON object.');
    expect(runOcrBridgeImport).not.toHaveBeenCalled();
  });

  it('returns 400 for JSON array and primitive bodies', async () => {
    for (const body of ['[]', '42', '"batchSize"', 'true']) {
      vi.resetModules();
      const { runOcrBridgeImport } = setup();
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(runOcrBridgeImport).not.toHaveBeenCalled();
    }
  });

  it('returns 400 for malformed JSON', async () => {
    const { runOcrBridgeImport } = setup();
    const res = await post('{not json');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Request body must be valid JSON.');
    expect(runOcrBridgeImport).not.toHaveBeenCalled();
  });

  it('treats an empty body as defaults and runs the import for the caller org', async () => {
    const { runOcrBridgeImport } = setup();
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
    expect(runOcrBridgeImport).toHaveBeenCalledTimes(1);
    expect(runOcrBridgeImport).toHaveBeenCalledWith(ORG, 50);
  });

  it('honours an explicit valid batchSize', async () => {
    const { runOcrBridgeImport } = setup();
    const res = await post(JSON.stringify({ batchSize: 7 }));
    expect(res.status).toBe(200);
    expect(runOcrBridgeImport).toHaveBeenCalledWith(ORG, 7);
  });
});

/**
 * Browser-side import orchestrator: expand the archive locally, upload one
 * entry per request, and report honest running totals.
 *
 * The three properties that matter to a non-developer closing his books:
 *   1. progress is a real count of finished items, not a spinner;
 *   2. a partial run reports what actually landed ("34 of 120 imported");
 *   3. re-running the same export resumes — every already-imported receipt
 *      comes back as a duplicate because the server keys on content hash.
 */
import { describe, it, expect, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { randomBytes } from 'node:crypto';
import {
  importWhatsappExport,
  describeImportFailure,
  type WhatsappImportProgress,
} from '../../src/lib/whatsapp-import-client';
import { ZipReaderError } from '../../src/lib/zip-reader';

function jpeg(bytes = 256): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(bytes)]);
}

function exportZip(imageCount = 3, extras: [string, Buffer][] = []): File {
  const zip = new AdmZip();
  zip.addFile('_chat.txt', Buffer.from('12/07/2026, 10:15 - Kumar: Bought cement\n', 'utf8'));
  for (let i = 0; i < imageCount; i += 1) {
    zip.addFile(`IMG-2026071${i}-WA000${i}.jpg`, jpeg());
  }
  for (const [name, data] of extras) zip.addFile(name, data);
  return new File([new Uint8Array(zip.toBuffer())], 'WhatsApp Chat - Ko Lake.zip');
}

/** Minimal fake server: one JSON response per /api/ingest/item call. */
function fakeFetch(handler: (url: string, init: RequestInit) => unknown, status = () => 200) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = handler(String(url), init ?? {});
    const code = status();
    return new Response(JSON.stringify(body), {
      status: code,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('importWhatsappExport', () => {
  it('uploads the chat transcript and every image as separate requests', async () => {
    const urls: string[] = [];
    const names: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url));
      const form = init?.body as FormData;
      if (form instanceof FormData && form.get('file')) {
        names.push((form.get('file') as File).name);
      }
      return new Response(
        JSON.stringify({ item: { name: 'x', kind: 'image', outcome: 'created', journalEntryId: 'je' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const report = await importWhatsappExport(exportZip(3), { fetchImpl });

    const itemCalls = urls.filter((u) => u.includes('/api/ingest/item'));
    expect(itemCalls).toHaveLength(4); // 1 chat + 3 images
    expect(names[0]).toBe('_chat.txt'); // chat first, so evidence precedes drafts
    expect(report.imageCount).toBe(3);
    expect(report.textCount).toBe(1);
  });

  it('never sends the whole archive in one request', async () => {
    const sizes: number[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      if (form instanceof FormData) {
        const f = form.get('file') as File | null;
        if (f) sizes.push(f.size);
      }
      return new Response(JSON.stringify({ item: { name: 'x', kind: 'image', outcome: 'created' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await importWhatsappExport(exportZip(3), { fetchImpl });
    // Every part is one entry, comfortably under the 4 MB per-request cap.
    for (const size of sizes) expect(size).toBeLessThan(4 * 1024 * 1024);
  });

  it('reports a real running count, one tick per finished item', async () => {
    const ticks: WhatsappImportProgress[] = [];
    const fetchImpl = fakeFetch(() => ({
      item: { name: 'x', kind: 'image', outcome: 'created', journalEntryId: 'je' },
    }));
    const report = await importWhatsappExport(exportZip(3), {
      fetchImpl,
      concurrency: 1,
      onProgress: (p) => ticks.push({ ...p }),
    });
    expect(ticks).toHaveLength(4);
    expect(ticks.map((t) => t.done)).toEqual([1, 2, 3, 4]);
    expect(ticks.every((t) => t.total === 4)).toBe(true);
    expect(report.attempted).toBe(4);
    expect(report.interrupted).toBe(false);
  });

  it('counts duplicates as deduped, not created — re-running is a no-op', async () => {
    const fetchImpl = fakeFetch((url) =>
      url.includes('/api/ingest/item')
        ? { item: { name: 'x', kind: 'image', outcome: 'duplicate', journalEntryId: 'je' } }
        : {},
    );
    const report = await importWhatsappExport(exportZip(3), { fetchImpl });
    expect(report.created).toBe(0);
    expect(report.deduped).toBe(3);
    expect(report.failures).toHaveLength(0);
  });

  it('keeps going after one item fails and names the file that failed', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      const name = form instanceof FormData ? (form.get('file') as File)?.name : '';
      n += 1;
      if (n === 3) {
        return new Response(JSON.stringify({ error: 'Zip ingestion failed.' }), { status: 500 });
      }
      return new Response(
        JSON.stringify({ item: { name, kind: 'image', outcome: 'created', journalEntryId: 'je' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const report = await importWhatsappExport(exportZip(3), { fetchImpl, concurrency: 1 });
    expect(report.created).toBe(2); // two image drafts; the chat transcript is evidence, not a draft
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].name).toBeTruthy();
    expect(report.failures[0].stage).toBe('upload');
  });

  it('surfaces a per-item network error rather than hanging', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const report = await importWhatsappExport(exportZip(1), { fetchImpl, concurrency: 1 });
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures[0].error).toMatch(/Failed to fetch/);
  });

  it('stops on abort and reports the partial progress truthfully', async () => {
    const controller = new AbortController();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 2) controller.abort();
      return new Response(
        JSON.stringify({ item: { name: 'x', kind: 'image', outcome: 'created', journalEntryId: 'je' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const report = await importWhatsappExport(exportZip(8), {
      fetchImpl,
      concurrency: 1,
      signal: controller.signal,
    });
    expect(report.interrupted).toBe(true);
    expect(report.attempted).toBeLessThan(report.imageCount + report.textCount);
    expect(report.attempted).toBeGreaterThan(0);
  });

  it('does not invent a failure for the request an abort cut off', async () => {
    // A cancelled request was never judged by the server, so reporting it as a
    // failed receipt would send the operator hunting for a problem that is not
    // there. The interrupted flag already says where the run stopped.
    const controller = new AbortController();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 2) {
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return new Response(
        JSON.stringify({ item: { name: 'x', kind: 'image', outcome: 'created', journalEntryId: 'je' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const report = await importWhatsappExport(exportZip(5), {
      fetchImpl,
      concurrency: 1,
      signal: controller.signal,
    });
    expect(report.interrupted).toBe(true);
    expect(report.failures).toHaveLength(0);
    expect(report.attempted).toBe(1);
  });

  it('carries one server-generated batch id across every request in the run', async () => {
    const batchIds = new Set<string>();
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const form = init?.body;
      if (form instanceof FormData) batchIds.add(String(form.get('batchId')));
      return new Response(JSON.stringify({ item: { name: 'x', kind: 'image', outcome: 'created' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const report = await importWhatsappExport(exportZip(3), { fetchImpl });
    expect(batchIds.size).toBe(1);
    expect([...batchIds][0]).toBe(report.batchId);
  });

  it('closes the batch with a summary call once every item is attempted', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ item: { name: 'x', kind: 'image', outcome: 'created' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    await importWhatsappExport(exportZip(2), { fetchImpl });
    expect(calls.at(-1)).toContain('/api/ingest/batch');
  });

  it('does not fail the whole import when the summary call fails', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/api/ingest/batch')) {
        return new Response('nope', { status: 500 });
      }
      return new Response(JSON.stringify({ item: { name: 'x', kind: 'image', outcome: 'created' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const report = await importWhatsappExport(exportZip(2), { fetchImpl });
    expect(report.created).toBe(2);
  });

  it('lists non-receipt entries as skipped without uploading them', async () => {
    const uploaded: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const form = init?.body;
      if (form instanceof FormData && form.get('file')) {
        uploaded.push((form.get('file') as File).name);
      }
      return new Response(JSON.stringify({ item: { name: 'x', kind: 'image', outcome: 'created' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const report = await importWhatsappExport(
      exportZip(1, [['PTT-1.opus', randomBytes(64)]]),
      { fetchImpl },
    );
    expect(uploaded).not.toContain('PTT-1.opus');
    expect(report.skipped.map((s) => s.name)).toContain('PTT-1.opus');
  });

  it('rejects a hostile archive locally, before a single byte is uploaded', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const zip = new AdmZip();
    zip.addFile('bomb.txt', Buffer.alloc(2 * 1024 * 1024, 0));
    const file = new File([new Uint8Array(zip.toBuffer())], 'evil.zip');
    await expect(importWhatsappExport(file, { fetchImpl })).rejects.toMatchObject({
      code: 'ZIP_BOMB',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('describeImportFailure', () => {
  it('turns each archive guard code into plain-language advice', () => {
    for (const code of ['INVALID_ZIP', 'TOO_MANY_ENTRIES', 'TOTAL_SIZE_EXCEEDED', 'PATH_TRAVERSAL', 'ZIP_BOMB', 'UNSUPPORTED_ZIP'] as const) {
      const out = describeImportFailure(new ZipReaderError(code, 'raw technical text'));
      expect(out.title.length).toBeGreaterThan(0);
      expect(out.message.length).toBeGreaterThan(0);
      expect(out.message).not.toMatch(/undefined/);
    }
  });

  it('explains an unsupported browser instead of failing silently', () => {
    const out = describeImportFailure(new ZipReaderError('UNSUPPORTED_BROWSER', 'no DecompressionStream'));
    expect(out.message).toMatch(/browser/i);
  });

  it('falls back to a generic message for an unknown error', () => {
    const out = describeImportFailure(new Error('boom'));
    expect(out.ok).toBe(false);
    expect(out.message.length).toBeGreaterThan(0);
  });
});

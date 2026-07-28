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
import { describe, it, expect, vi, afterEach } from 'vitest';
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

/**
 * Fake only the timer functions the code under test uses.
 *
 * Faking setImmediate/nextTick as well would freeze Node's stream internals,
 * and the archive is expanded through DecompressionStream — the reader would
 * simply never finish and every test here would time out on real seconds.
 */
function useTimerFakes() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

/** Let the real event loop turn so zlib/stream callbacks can run. */
async function flushIo(turns = 12) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Interleave real IO turns with small virtual-time steps until `predicate`
 * holds. Expanding the archive is real async work (DecompressionStream) that
 * fake timers cannot drive, so a fixed "advance N ms" is a race; this waits for
 * the condition instead.
 */
async function waitUntil(predicate: () => boolean, stepMs = 10, steps = 200) {
  for (let i = 0; i < steps; i += 1) {
    if (predicate()) return;
    await flushIo(4);
    await vi.advanceTimersByTimeAsync(stepMs);
  }
}

/**
 * Drive virtual time until `promise` settles, then return it.
 *
 * `stepMs` is how much virtual time each turn of the real event loop costs.
 * Keep it SMALL when the test asserts something about gaps between events
 * (e.g. the inactivity watchdog): a large step makes slow real IO look like a
 * long silence and can trip a watchdog that would never fire in production.
 */
async function settle<T>(promise: Promise<T>, stepMs = 500, steps = 400): Promise<T> {
  let done = false;
  const tracked = promise.then(
    (value) => {
      done = true;
      return value;
    },
    (err) => {
      done = true;
      throw err;
    },
  );
  for (let i = 0; i < steps && !done; i += 1) {
    await flushIo(4);
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  return tracked;
}

const okItem = () =>
  new Response(
    JSON.stringify({ item: { name: 'x', kind: 'image', outcome: 'created', journalEntryId: 'je' } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const callCount = (f: typeof fetch) => (f as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

describe('rate-limit backoff', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits the server’s retry-after instead of hammering it, then carries on', async () => {
    useTimerFakes();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '20' } });
      return okItem();
    }) as unknown as typeof fetch;

    const run = importWhatsappExport(exportZip(0), { fetchImpl, concurrency: 1 });
    await waitUntil(() => callCount(fetchImpl) >= 1);
    expect(callCount(fetchImpl)).toBe(1);

    // Well inside the 20 s the server asked for: no retry yet.
    await vi.advanceTimersByTimeAsync(10_000);
    await flushIo();
    expect(callCount(fetchImpl)).toBe(1);

    const report = await settle(run);
    expect(callCount(fetchImpl)).toBeGreaterThan(1);
    expect(report.chatFiles).toHaveLength(1);
    expect(report.failures).toHaveLength(0);
  });

  it('clamps an absurd retry-after so a hostile header cannot park the import', async () => {
    useTimerFakes();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      // 24 hours. Honoured literally, the import would never resume.
      if (n === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '86400' } });
      return okItem();
    }) as unknown as typeof fetch;

    const run = importWhatsappExport(exportZip(0), { fetchImpl, concurrency: 1 });
    await waitUntil(() => callCount(fetchImpl) >= 1);

    const report = await settle(run);
    // Resolved at all — 24 h would have outlasted every step settle() takes.
    expect(callCount(fetchImpl)).toBeGreaterThan(1);
    expect(report.chatFiles).toHaveLength(1);
    expect(report.failures).toHaveLength(0);
  });

  it('gives up after the attempt cap and reports the item as failed', async () => {
    useTimerFakes();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: 'Too many uploads at once' }), { status: 429 }),
    ) as unknown as typeof fetch;

    const report = await settle(
      importWhatsappExport(exportZip(0), { fetchImpl, concurrency: 1 }),
    );

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].stage).toBe('upload');
    // Three attempts for the item (+ at most the batch close) — bounded, not a
    // retry loop that could hammer a struggling server forever.
    expect(callCount(fetchImpl)).toBeLessThanOrEqual(4);
  });

  it('observes an abort DURING the backoff wait instead of sleeping it out', async () => {
    useTimerFakes();
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
    ) as unknown as typeof fetch;

    const run = importWhatsappExport(exportZip(0), {
      fetchImpl,
      concurrency: 1,
      signal: controller.signal,
    });
    await waitUntil(() => callCount(fetchImpl) >= 1);
    // The first 429 has landed and the 30 s wait has begun.
    expect(callCount(fetchImpl)).toBe(1);

    controller.abort();
    // Barely any virtual time passes: an unaware sleep would still be parked
    // for the rest of the 30 s and this would not settle here.
    await vi.advanceTimersByTimeAsync(50);
    await flushIo();
    const report = await run;

    expect(report.interrupted).toBe(true);
    expect(report.interruptedReason).toBe('cancelled');
  });
});

describe('never hang silently', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never calls the batch summary endpoint after an abort', async () => {
    const controller = new AbortController();
    const urls: string[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      n += 1;
      if (n === 2) {
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return new Response(JSON.stringify({ item: { name: 'x', kind: 'image', outcome: 'created' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const report = await importWhatsappExport(exportZip(6), {
      fetchImpl,
      concurrency: 1,
      signal: controller.signal,
    });
    expect(report.interrupted).toBe(true);
    // Closing a run that did not finish would record a summary of a partial
    // import as though it were the whole thing.
    expect(urls.some((u) => u.includes('/api/ingest/batch'))).toBe(false);
  });

  it('stops a stalled import on the inactivity watchdog and says so', async () => {
    useTimerFakes();
    // A request that never answers — but that DOES honour its abort signal,
    // exactly as a real fetch does. Without a watchdog the card sits on
    // "Importing…" forever, which is the failure this work exists to kill.
    const fetchImpl = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
    ) as unknown as typeof fetch;

    const report = await settle(
      importWhatsappExport(exportZip(3), { fetchImpl, concurrency: 1, idleTimeoutMs: 1000 }),
    );

    expect(report.interrupted).toBe(true);
    expect(report.interruptedReason).toBe('idle-timeout');
    expect(report.attempted).toBe(0);
  });

  it('does not fire the watchdog while items keep completing', async () => {
    useTimerFakes();
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return okItem();
    }) as unknown as typeof fetch;

    // Five items at 800 ms each is far more total elapsed time than the 5 s
    // watchdog, yet no single gap between completions comes close to it. The
    // watchdog measures SILENCE, not duration, so a long healthy import runs
    // to the end instead of being cancelled for taking a while.
    const report = await settle(
      importWhatsappExport(exportZip(4), { fetchImpl, concurrency: 1, idleTimeoutMs: 5000 }),
      25,
      2000,
    );

    expect(report.interrupted).toBe(false);
    expect(report.created).toBe(4);
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

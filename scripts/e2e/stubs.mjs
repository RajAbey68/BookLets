/**
 * The two pieces of the real world the harness has to stand in for.
 *
 * 1. THE OCR MICROSERVICE (src/lib/gemini-ocr.ts POSTs to
 *    OCR_MICROSERVICE_URL/ocr). This is a paid third-party service. Calling it
 *    120 times per scenario would cost money, be slow, and make results
 *    non-deterministic — and it is not the thing under test. The stub answers
 *    in the real response shape and is DETERMINISTIC per image (the amount is
 *    derived from the image bytes), so "what should the ledger contain?" has
 *    an exact answer the harness can check the database against.
 *
 *    It is also where failure is injected: latency, error rates, zero amounts.
 *
 * 2. VERCEL'S EDGE BODY LIMIT. This is the bug that made 720 green unit tests
 *    worthless: Vercel rejects a request body over ~4.5 MB with
 *    413 FUNCTION_PAYLOAD_TOO_LARGE *before* the serverless function runs, so
 *    POST /api/ingest/zip never saw a real archive. `next start` on a laptop
 *    has no such limit, so a purely local harness would happily accept a
 *    28.5 MB upload and report success — reproducing the exact false
 *    confidence this whole exercise exists to end.
 *
 *    The edge proxy therefore sits in FRONT of the local Next server and
 *    enforces the same ceiling, the same way: count the bytes, and cut the
 *    request off with a plain-text 413 before the app ever sees it. It is a
 *    simulation of documented platform behaviour, and it is labelled as such
 *    in the harness output.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';

/** Vercel's serverless request-body ceiling (documented as 4.5 MB). */
export const VERCEL_BODY_LIMIT_BYTES = Math.floor(4.5 * 1024 * 1024);

const CATEGORIES = [
  'Groceries',
  'Dining',
  'Utilities',
  'Transport',
  'Office Supplies',
  'Accommodation',
  'Healthcare',
  'Entertainment',
  'Other',
];

/**
 * The amount the stub will return for a given image — derived from the bytes,
 * so the harness knows the expected ledger total before it uploads anything.
 */
export function expectedExtraction(imageBytes) {
  const hash = createHash('sha256').update(imageBytes).digest();
  const cents = 250 + (hash.readUInt32BE(0) % 2_000_000); // 2.50 – 20 002.50
  return {
    vendorName: `Stub Vendor ${hash.readUInt16BE(4) % 500}`,
    date: '2026-07-12',
    totalAmount: Math.round(cents) / 100,
    categorySuggestion: CATEGORIES[hash[6] % CATEGORIES.length],
    confidence: 0.55 + (hash[7] % 40) / 100,
  };
}

/**
 * Start the OCR stub.
 *
 * @param {object} options
 * @param {number} options.port
 * @param {number} [options.latencyMs]      per-call delay; model real OCR cost
 * @param {number} [options.failEveryNth]   0 = never; N = every Nth call 500s
 * @param {number} [options.zeroAmountNth]  0 = never; N = every Nth call returns 0
 * @param {number} [options.hangEveryNth]   0 = never; N = every Nth call never answers
 */
export async function startOcrStub(options) {
  const state = {
    calls: 0,
    latencyMs: options.latencyMs ?? 0,
    failEveryNth: options.failEveryNth ?? 0,
    zeroAmountNth: options.zeroAmountNth ?? 0,
    hangEveryNth: options.hangEveryNth ?? 0,
    maxConcurrent: 0,
    inFlight: 0,
    callTimes: [],
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/ocr')) {
      res.writeHead(404).end('{}');
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      state.calls += 1;
      state.inFlight += 1;
      state.callTimes.push(Date.now());
      state.maxConcurrent = Math.max(state.maxConcurrent, state.inFlight);
      const n = state.calls;

      const finish = (status, body) => {
        state.inFlight -= 1;
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };

      if (state.hangEveryNth && n % state.hangEveryNth === 0) {
        // Never answer: exercises the OCR client's own AbortController timeout.
        return;
      }
      if (state.latencyMs > 0) await new Promise((r) => setTimeout(r, state.latencyMs));
      if (state.failEveryNth && n % state.failEveryNth === 0) {
        finish(500, { error: 'stub: injected OCR failure' });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        finish(400, { error: 'stub: bad request' });
        return;
      }
      const imageBytes = Buffer.from(String(payload.imageBase64 ?? ''), 'base64');
      const extraction = expectedExtraction(imageBytes);
      if (state.zeroAmountNth && n % state.zeroAmountNth === 0) extraction.totalAmount = 0;

      finish(200, { text: JSON.stringify(extraction), confidence: extraction.confidence });
    });
  });

  await new Promise((resolve) => server.listen(options.port, '127.0.0.1', resolve));
  return {
    state,
    reset() {
      state.calls = 0;
      state.maxConcurrent = 0;
      state.callTimes = [];
    },
    configure(patch) {
      Object.assign(state, patch);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Start the Vercel-edge simulator in front of `target`.
 *
 * Behaviour copied from the platform, not invented: bodies at or under the
 * limit are proxied through untouched; a body that exceeds it is answered with
 * a plain-text 413 (Vercel's is plain text, not JSON — which is precisely why
 * ZipUploadCard has to guard `res.json()` with a try/catch) and the upstream
 * request is destroyed without the app being invoked.
 */
export async function startEdgeProxy({ port, targetPort, limitBytes = VERCEL_BODY_LIMIT_BYTES, enabled = true }) {
  const state = { rejected: 0, passed: 0, limitBytes, enabled };

  const server = http.createServer((clientReq, clientRes) => {
    let forwarded = 0;
    let killed = false;

    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        method: clientReq.method,
        path: clientReq.url,
        headers: { ...clientReq.headers, host: `127.0.0.1:${targetPort}` },
      },
      (upstreamRes) => {
        if (killed) return;
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );

    upstream.on('error', () => {
      if (killed || clientRes.headersSent) return;
      clientRes.writeHead(502, { 'content-type': 'text/plain' }).end('edge-proxy: upstream error');
    });

    const reject = () => {
      killed = true;
      state.rejected += 1;
      upstream.destroy();
      if (!clientRes.headersSent) {
        // Vercel answers a plain-text error body here, not JSON.
        clientRes.writeHead(413, { 'content-type': 'text/plain' });
      }
      clientRes.end('FUNCTION_PAYLOAD_TOO_LARGE\n');
      clientReq.destroy();
    };

    if (state.enabled) {
      const declared = Number(clientReq.headers['content-length']);
      if (Number.isFinite(declared) && declared > state.limitBytes) {
        reject();
        return;
      }
    }

    clientReq.on('data', (chunk) => {
      if (killed) return;
      forwarded += chunk.length;
      if (state.enabled && forwarded > state.limitBytes) {
        reject();
        return;
      }
      upstream.write(chunk);
    });
    clientReq.on('end', () => {
      if (killed) return;
      state.passed += 1;
      upstream.end();
    });
    clientReq.on('error', () => upstream.destroy());
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    state,
    setEnabled(value) {
      state.enabled = value;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
    },
  };
}

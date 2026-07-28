/**
 * BookLets end-to-end receipt-import harness.
 *
 * This exists because 720 unit tests were green while the import feature had
 * never once worked in production. Every one of those tests mocks the network
 * boundary — and the network boundary was the broken part. So this harness
 * mocks nothing it is testing: it generates a real WhatsApp archive, uploads it
 * over real HTTP to a real build of the application, through a proxy that
 * enforces the same request-body ceiling the hosting platform enforces, and
 * then checks the RESULT IN THE DATABASE rather than believing the response.
 *
 * Run it with:  npm run e2e            (full scale — ~120 photos, ~28.5 MB)
 *               npm run e2e:quick      (small archive, for a fast signal)
 *
 * What it does NOT cover is printed at the end of every run, every time.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { buildWhatsappExport } from './whatsapp-export.mjs';
import { startOcrStub, startEdgeProxy, expectedExtraction, VERCEL_BODY_LIMIT_BYTES } from './stubs.mjs';
import { mintSessionCookie, mintExpiredSessionCookie } from './session.mjs';
import {
  connect,
  provisionOrg,
  resetLedger,
  ledgerFacts,
  findUnbalancedEntries,
  findDuplicateKeys,
  ensureFiscalPeriod,
  clearFiscalPeriods,
} from './db.mjs';
import {
  assertDisposableDatabase,
  assertPortFree,
  startPostgres,
  applySchema,
  startNextServer,
} from './env.mjs';
import {
  detectTransports,
  expandArchive,
  importArchive,
  uploadPerItem,
  TRANSPORT_ITEM,
  TRANSPORT_ZIP,
} from './transports.mjs';

// ── configuration ────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? 'true'];
    }),
);

const QUICK = args.quick === 'true';
const CONFIG = {
  images: Number(args.images ?? (QUICK ? 24 : 120)),
  totalMb: Number(args['total-mb'] ?? (QUICK ? 6 : 28.5)),
  ocrLatencyMs: Number(args['ocr-latency'] ?? (QUICK ? 50 : 400)),
  basePort: Number(args.port ?? 3310),
  dbPort: Number(args['db-port'] ?? 55432),
  skipBuild: args['skip-build'] === 'true',
  skipBrowser: args['no-browser'] === 'true',
  keepDb: args['keep-db'] === 'true',
  outDir: args.out ?? path.join(os.tmpdir(), 'booklets-e2e'),
};

const PORTS = {
  edge: CONFIG.basePort,
  next: CONFIG.basePort + 1,
  ocr: CONFIG.basePort + 2,
};

const ORG = {
  orgId: 'e2e-org',
  orgName: 'E2E Harness Books',
  orgSlug: 'e2e-harness',
  userId: 'e2e-user',
  email: 'e2e-harness@booklets.test',
};

const AUTH_SECRET = 'e2e-harness-only-secret-not-used-anywhere-else-0123456789';

// ── reporting ────────────────────────────────────────────────────────────────

const findings = [];
const scenarios = [];
let currentScenario = null;

const log = (...parts) => console.log(...parts);
const mb = (n) => `${(n / (1024 * 1024)).toFixed(2)} MB`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

function scenario(id, title) {
  currentScenario = { id, title, checks: [], startedAt: Date.now() };
  scenarios.push(currentScenario);
  log(`\n── ${id} — ${title}`);
  return currentScenario;
}

function finish() {
  if (currentScenario) currentScenario.elapsedMs = Date.now() - currentScenario.startedAt;
}

function record(severity, title, detail, evidence) {
  const finding = { scenario: currentScenario?.id ?? 'setup', severity, title, detail, evidence };
  findings.push(finding);
  const mark = severity === 'FAIL' ? 'FAIL' : severity === 'WARN' ? 'WARN' : 'INFO';
  log(`   [${mark}] ${title}${detail ? ` — ${detail}` : ''}`);
  return finding;
}

/** Assert, and record the outcome either way so a pass is also evidence. */
function check(ok, title, detail, evidence) {
  currentScenario?.checks.push({ ok, title });
  if (ok) log(`   [ ok ] ${title}${detail ? ` — ${detail}` : ''}`);
  else record('FAIL', title, detail, evidence);
  return ok;
}

const warn = (title, detail, evidence) => record('WARN', title, detail, evidence);
const info = (title, detail, evidence) => record('INFO', title, detail, evidence);

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  await mkdir(CONFIG.outDir, { recursive: true });

  log('BookLets end-to-end receipt-import harness');
  log(`  archive under test : ${CONFIG.images} photos, target ${CONFIG.totalMb} MB`);
  log(`  OCR                : stubbed locally at ${CONFIG.ocrLatencyMs}ms/call (deterministic amounts)`);
  log(`  platform edge      : simulated at ${mb(VERCEL_BODY_LIMIT_BYTES)} request-body ceiling`);
  log(`  artefacts          : ${CONFIG.outDir}`);

  // ── environment ────────────────────────────────────────────────────────────
  await assertPortFree(PORTS.edge, 'edge proxy');
  await assertPortFree(PORTS.next, 'next start');
  await assertPortFree(PORTS.ocr, 'OCR stub');

  const databaseUrl = process.env.E2E_DATABASE_URL ?? null;
  let pg = null;
  let dbUrl = databaseUrl;
  if (!dbUrl) {
    pg = await startPostgres({ port: CONFIG.dbPort, database: 'booklets_e2e', log });
    dbUrl = pg.url;
  }
  assertDisposableDatabase(dbUrl);
  await applySchema(dbUrl, { log });

  const db = await connect(dbUrl);
  await provisionOrg(db, ORG);

  const ocr = await startOcrStub({ port: PORTS.ocr, latencyMs: CONFIG.ocrLatencyMs });
  const server = await startNextServer({
    port: PORTS.next,
    databaseUrl: dbUrl,
    skipBuild: CONFIG.skipBuild,
    log,
    env: {
      AUTH_SECRET,
      AUTH_URL: `http://127.0.0.1:${PORTS.edge}`,
      NEXTAUTH_URL: `http://127.0.0.1:${PORTS.edge}`,
      AUTH_ALLOWED_EMAILS: ORG.email,
      AUTH_GOOGLE_ID: 'e2e-harness-client-id',
      AUTH_GOOGLE_SECRET: 'e2e-harness-client-secret',
      OCR_MICROSERVICE_URL: `http://127.0.0.1:${PORTS.ocr}`,
      OCR_TIMEOUT_MS: '20000',
    },
  });
  const edge = await startEdgeProxy({ port: PORTS.edge, targetPort: PORTS.next });
  const baseUrl = `http://127.0.0.1:${PORTS.edge}`;

  const session = await mintSessionCookie({ secret: AUTH_SECRET, userId: ORG.userId, email: ORG.email });
  const expired = await mintExpiredSessionCookie({ secret: AUTH_SECRET, userId: ORG.userId, email: ORG.email });

  const cleanup = async () => {
    await edge.close().catch(() => {});
    await server.stop().catch(() => {});
    await ocr.close().catch(() => {});
    await db.end().catch(() => {});
    if (pg && !CONFIG.keepDb) await pg.stop().catch(() => {});
  };

  try {
    await runScenarios({ baseUrl, session, expired, db, ocr, edge, server });
  } finally {
    await writeReport(startedAt, server);
    await cleanup();
  }

  const failed = findings.filter((f) => f.severity === 'FAIL');
  process.exitCode = failed.length > 0 ? 1 : 0;
}

// ── scenarios ────────────────────────────────────────────────────────────────

async function runScenarios(ctx) {
  const { baseUrl, session, expired, db, ocr, edge } = ctx;

  // ── 0. session + transport discovery ───────────────────────────────────────
  scenario('S0', 'The harness is genuinely signed in, and knows which transport this build serves');
  const whoami = await fetch(`${baseUrl}/api/export/trial-balance`, { headers: { cookie: session.header } });
  check(
    whoami.status !== 401,
    'the minted session is accepted by the real auth gate',
    `GET /api/export/trial-balance → ${whoami.status}`,
  );
  const anon = await fetch(`${baseUrl}/api/export/trial-balance`);
  check(anon.status === 401, 'an unauthenticated request is still rejected', `→ ${anon.status}`);

  const transports = await detectTransports(baseUrl, session.header);
  info(
    'transports served by this build',
    transports.available.join(', ') || 'none',
    transports,
  );
  const primary = transports.available.includes(TRANSPORT_ITEM) ? TRANSPORT_ITEM : TRANSPORT_ZIP;
  if (primary === TRANSPORT_ZIP) {
    warn(
      'this build only has the single-request /api/ingest/zip transport',
      'PR #133 (per-item upload) is not in this build, so the scale and dedup scenarios below run ' +
        'against a transport the hosting platform rejects for any real archive. Their results say the ' +
        'server-side pipeline works; they do NOT say the operator can use it. See scenario S1.',
    );
  }
  finish();

  // ── 1. the production failure itself ───────────────────────────────────────
  scenario('S1', 'A real 28.5 MB archive against the platform edge — the bug that shipped');
  const real = buildWhatsappExport({
    images: CONFIG.images,
    totalBytes: Math.round(CONFIG.totalMb * 1024 * 1024),
    seed: 1,
  });
  await writeFile(path.join(CONFIG.outDir, 'archive-primary.zip'), real.zip);
  info(
    'generated archive',
    `${real.manifest.entryCount} entries, ${real.manifest.photoCount} photos, ${mb(real.manifest.zipBytes)} ` +
      `(deflate ratio ${(real.manifest.zipBytes / real.manifest.photoBytes).toFixed(3)} — real photo archives barely compress)`,
  );

  // The edge check must not depend on how the run was configured: a --quick
  // archive can be under the ceiling, and "it fitted" is not evidence about
  // the real 28.5 MB case. So the oversize probe always uses an archive that
  // is genuinely over the platform limit.
  const oversize =
    real.zip.length > VERCEL_BODY_LIMIT_BYTES
      ? real
      : buildWhatsappExport({ images: 24, totalBytes: 6 * 1024 * 1024, seed: 2 });
  if (oversize !== real) {
    info(
      'the configured archive is smaller than a real export',
      `${mb(real.zip.length)} is under the ${mb(VERCEL_BODY_LIMIT_BYTES)} ceiling, so a separate ` +
        `${mb(oversize.zip.length)} archive is used for the edge check`,
    );
  }

  await resetLedger(db, ORG.orgId);
  const zipThroughEdge = await importArchive(TRANSPORT_ZIP, {
    baseUrl,
    cookie: session.header,
    zipBuffer: oversize.zip,
  });
  check(
    zipThroughEdge.status === 413,
    'the single-request zip upload is rejected at the platform edge, exactly as in production',
    `POST /api/ingest/zip (${mb(oversize.zip.length)}) → ${zipThroughEdge.status}`,
    zipThroughEdge.body,
  );
  const afterEdge = await ledgerFacts(db, ORG.orgId);
  check(afterEdge.entryCount === 0, 'nothing reached the books through the rejected upload', `${afterEdge.entryCount} rows`);
  finish();

  // ── 1b. a brand-new organisation, configured exactly as production is ─────
  // Production was set up WITHOUT prisma/seed.ts (the seed creates demo Dublin
  // properties and must never touch the real books). So the live organisation
  // has no FiscalPeriod row — and nothing in the application can create one.
  // This scenario asks the only question that matters once the transport is
  // fixed: on a real, unseeded organisation, does a receipt actually land?
  scenario('S1b', 'A brand-new organisation with no fiscal period — production’s actual configuration');
  await clearFiscalPeriods(db, ORG.orgId);
  await resetLedger(db, ORG.orgId);
  ocr.reset();
  const coldArchive = buildWhatsappExport({ images: 3, totalBytes: 450 * 1024, seed: 3, startIndex: 20_000 });
  if (primary === TRANSPORT_ZIP) edge.setEnabled(false);
  const cold = await importArchive(primary, {
    baseUrl,
    cookie: session.header,
    zipBuffer: coldArchive.zip,
    archiveName: 'cold-start.zip',
  });
  edge.setEnabled(true);
  const coldFacts = await ledgerFacts(db, ORG.orgId);
  const coldFailureReasons = collectFailureReasons(cold);
  check(
    coldFacts.draftCount === coldArchive.manifest.photoCount,
    'a receipt imported into a freshly deployed organisation reaches the books',
    `${coldFacts.draftCount} of ${coldArchive.manifest.photoCount} landed; ` +
      `first reported failure: ${coldFailureReasons[0] ?? '(none)'}`,
    { reported: cold.reported, failures: coldFailureReasons.slice(0, 3) },
  );
  check(
    ocr.state.calls === 0 || coldFacts.draftCount > 0,
    'OCR is not paid for on receipts the ledger was always going to reject',
    `${ocr.state.calls} OCR calls were made and ${coldFacts.draftCount} receipts landed`,
  );
  if (coldFacts.draftCount === 0) {
    record(
      'FAIL',
      'a fresh organisation cannot import anything, and the product offers no way to fix it',
      'Every entry is refused by LedgerService.checkFiscalPeriod, and the only code in the repository ' +
        'that creates a FiscalPeriod is prisma/seed.ts — which seeds demo properties and must never be ' +
        'run against production. There is no UI, server action or admin route that creates one.',
      { reported: cold.reported, reasons: coldFailureReasons.slice(0, 3) },
    );
  }
  // Restore a workable organisation so the rest of the harness can test the
  // import itself rather than re-discovering this one wall over and over.
  await ensureFiscalPeriod(db, ORG.orgId);
  await ensureFiscalPeriod(db, ORG.orgId, 2026);
  info('fiscal period provisioned for the remaining scenarios', 'so the rest of the pipeline can be tested');
  finish();

  // ── 2. full scale over the transport the operator will use ────────────────
  scenario('S2', `Full-scale import: ${CONFIG.images} photos, ${mb(real.zip.length)}`);
  if (primary === TRANSPORT_ZIP) {
    warn(
      'edge simulation disabled for this scenario',
      'the only transport available cannot pass the edge; disabling it isolates the server pipeline. ' +
        'On the real deployment this upload never arrives at all.',
    );
    edge.setEnabled(false);
  }
  await resetLedger(db, ORG.orgId);
  ocr.reset();

  const before = Date.now();
  const bulk = await importArchive(primary, {
    baseUrl,
    cookie: session.header,
    zipBuffer: real.zip,
    archiveName: 'WhatsApp Chat - Ko Lake Ops.zip',
  });
  const bulkElapsed = Date.now() - before;
  edge.setEnabled(true);

  const facts = await ledgerFacts(db, ORG.orgId);
  info(
    'import finished',
    `${secs(bulkElapsed)} for ${CONFIG.images} photos ` +
      `(${(bulkElapsed / Math.max(1, CONFIG.images)).toFixed(0)}ms/photo), OCR calls ${ocr.state.calls}, ` +
      `peak OCR concurrency ${ocr.state.maxConcurrent}`,
  );

  check(
    bulk.ok || bulk.status === 200,
    'the import completed rather than erroring out',
    `status ${bulk.status}`,
    bulk.body ?? bulk.batchResult,
  );
  const bulkFailures = collectFailureReasons(bulk);
  check(
    bulkFailures.length === 0,
    'no receipt was rejected by the server',
    bulkFailures.length ? `${bulkFailures.length} rejected — e.g. ${bulkFailures[0]}` : 'none',
    bulkFailures.slice(0, 5),
  );
  check(
    facts.draftCount === CONFIG.images,
    `all ${CONFIG.images} receipts became DRAFT journal entries in the database`,
    `database has ${facts.draftCount} DRAFT rows`,
    { byStatus: facts.byStatus },
  );
  check(facts.postedCount === 0, 'nothing was posted straight to the books', `${facts.postedCount} POSTED rows`);

  // Truthfulness — the single worst class of bug in this product.
  const reported = bulk.reported ?? { created: null };
  check(
    reported.created === facts.draftCount,
    'the number reported to the operator equals the number of rows in the database',
    `reported ${reported.created}, database ${facts.draftCount}`,
    { reported, liveTally: bulk.liveTally },
  );

  const unbalanced = findUnbalancedEntries(facts);
  check(unbalanced.length === 0, 'every created entry is a balanced double-entry pair', `${unbalanced.length} bad`, unbalanced.slice(0, 5));
  const dupKeys = findDuplicateKeys(facts);
  check(dupKeys.length === 0, 'no duplicate idempotency keys were written', `${dupKeys.length} duplicated`, dupKeys.slice(0, 5));

  // The amounts are deterministic, so the ledger total is knowable in advance.
  const expectedTotal = real.manifest.photos.reduce((sum, photo) => {
    const bytes = photoBytesFor(real, photo.name);
    return sum + expectedExtraction(bytes).totalAmount;
  }, 0);
  const actualDebits = [...facts.linesByEntry.values()]
    .flat()
    .filter((l) => l.isDebit)
    .reduce((sum, l) => sum + Number(l.amount), 0);
  check(
    Math.abs(actualDebits - expectedTotal) < 0.01,
    'the money in the ledger equals the money the receipts said',
    `expected ${expectedTotal.toFixed(2)}, ledger ${actualDebits.toFixed(2)}`,
  );

  const rateLimited = (bulk.perItem ?? []).filter((r) => r.status === 429);
  if (rateLimited.length > 0) {
    warn(
      'the rate limiter throttled a legitimate bulk import',
      `${rateLimited.length} of ${CONFIG.images} uploads were answered 429 after the client's retries were exhausted`,
      rateLimited.slice(0, 5),
    );
  }
  if (ocr.state.maxConcurrent > 6) {
    warn('OCR fan-out exceeded the documented cap', `peak ${ocr.state.maxConcurrent} concurrent OCR calls`);
  }
  finish();

  // ── 3. dedup, checked against the database ────────────────────────────────
  scenario('S3', 'Re-importing the identical archive must create nothing');
  if (primary === TRANSPORT_ZIP) edge.setEnabled(false);
  const beforeIds = new Set(facts.entries.map((e) => e.id));
  ocr.reset();
  const second = await importArchive(primary, {
    baseUrl,
    cookie: session.header,
    zipBuffer: real.zip,
    archiveName: 'WhatsApp Chat - Ko Lake Ops.zip',
  });
  edge.setEnabled(true);
  const afterSecond = await ledgerFacts(db, ORG.orgId);
  const newIds = afterSecond.entries.filter((e) => !beforeIds.has(e.id));

  check(newIds.length === 0, 'the second import created zero new journal entries', `${newIds.length} new rows`, newIds.slice(0, 5));
  check(
    (second.reported?.created ?? 0) === 0,
    'the operator is told nothing new was imported',
    `reported created=${second.reported?.created}, deduped=${second.reported?.deduped}`,
  );
  check(
    ocr.state.calls === 0,
    'no OCR budget was spent re-reading receipts already in the books',
    `${ocr.state.calls} OCR calls on the repeat import`,
  );
  finish();

  // ── 4. overlapping archive ────────────────────────────────────────────────
  scenario('S4', 'An overlapping export — only the genuinely new receipts may land');
  const overlapNew = Math.max(4, Math.round(CONFIG.images / 2));
  const overlapStart = CONFIG.images - Math.round(CONFIG.images / 4) + 1; // shares the tail
  const overlap = buildWhatsappExport({
    images: overlapNew,
    // Same seed AND same mean size, so the shared photos are byte-identical to
    // the ones already imported — otherwise this tests nothing.
    seed: 1,
    meanBytes: real.manifest.meanBytes,
    startIndex: overlapStart,
  });
  const sharedHashes = new Set(real.manifest.photos.map((p) => p.sha256));
  const shared = overlap.manifest.photos.filter((p) => sharedHashes.has(p.sha256)).length;
  const genuinelyNew = overlap.manifest.photoCount - shared;
  info('overlapping archive', `${overlap.manifest.photoCount} photos, ${shared} already imported, ${genuinelyNew} new`);

  const beforeOverlap = (await ledgerFacts(db, ORG.orgId)).entryCount;
  if (primary === TRANSPORT_ZIP) edge.setEnabled(false);
  ocr.reset();
  const third = await importArchive(primary, {
    baseUrl,
    cookie: session.header,
    zipBuffer: overlap.zip,
    archiveName: 'overlap.zip',
  });
  edge.setEnabled(true);
  const afterOverlap = await ledgerFacts(db, ORG.orgId);
  const delta = afterOverlap.entryCount - beforeOverlap;
  check(delta === genuinelyNew, `exactly the ${genuinelyNew} new receipts were added`, `database grew by ${delta}`);
  check(
    (third.reported?.created ?? -1) === delta,
    'the reported count matches the database growth',
    `reported ${third.reported?.created}, actual ${delta}`,
  );
  check(
    ocr.state.calls === genuinelyNew,
    'OCR was spent only on the new receipts',
    `${ocr.state.calls} OCR calls for ${genuinelyNew} new photos`,
  );
  finish();

  // ── 5. interruption and resume ────────────────────────────────────────────
  scenario('S5', 'Killing an import midway: the work done must persist, and resuming must not duplicate');
  await resetLedger(db, ORG.orgId);
  ocr.reset();
  if (primary === TRANSPORT_ITEM) {
    const stopAfter = Math.max(3, Math.floor(CONFIG.images / 3));
    const partial = await uploadPerItem({
      baseUrl,
      cookie: session.header,
      zipBuffer: real.zip,
      stopAfter,
      archiveName: 'interrupted.zip',
    });
    const midway = await ledgerFacts(db, ORG.orgId);
    check(
      midway.draftCount > 0,
      'the receipts uploaded before the interruption are really in the database',
      `${midway.draftCount} DRAFT rows after aborting at ${stopAfter} uploads`,
    );
    check(
      partial.batchResult === null,
      'an abandoned run writes no completion summary',
      partial.batchResult ? JSON.stringify(partial.batchResult).slice(0, 200) : 'no summary written',
    );

    const resumed = await uploadPerItem({
      baseUrl,
      cookie: session.header,
      zipBuffer: real.zip,
      archiveName: 'resumed.zip',
    });
    const afterResume = await ledgerFacts(db, ORG.orgId);
    check(
      afterResume.draftCount === CONFIG.images,
      're-running finishes the job',
      `${afterResume.draftCount} of ${CONFIG.images} receipts in the books`,
    );
    check(
      findDuplicateKeys(afterResume).length === 0,
      'resuming duplicated nothing',
      `${findDuplicateKeys(afterResume).length} duplicated keys`,
    );
    check(
      (resumed.reported?.created ?? 0) + midway.draftCount === CONFIG.images,
      'the resumed run reports only what it actually added',
      `${midway.draftCount} before + ${resumed.reported?.created} reported = ${midway.draftCount + (resumed.reported?.created ?? 0)}`,
    );
  } else {
    // The single-request transport is all-or-nothing from the browser's point
    // of view, but the SERVER still commits entries one at a time. Aborting the
    // request mid-flight is the closest equivalent, and it must not roll back
    // the receipts already committed, nor duplicate them on the retry.
    edge.setEnabled(false);
    const controller = new AbortController();
    const inFlight = importArchive(TRANSPORT_ZIP, {
      baseUrl,
      cookie: session.header,
      zipBuffer: real.zip,
      signal: controller.signal,
    }).catch((err) => ({ aborted: true, error: String(err?.message ?? err) }));
    await new Promise((r) => setTimeout(r, Math.max(1500, CONFIG.ocrLatencyMs * 4)));
    controller.abort();
    await inFlight;
    await new Promise((r) => setTimeout(r, 2000));
    const midway = await ledgerFacts(db, ORG.orgId);
    info('after aborting the request', `${midway.draftCount} DRAFT rows had already been committed`);

    const resumed = await importArchive(TRANSPORT_ZIP, {
      baseUrl,
      cookie: session.header,
      zipBuffer: real.zip,
    });
    const afterResume = await ledgerFacts(db, ORG.orgId);
    edge.setEnabled(true);
    check(
      afterResume.draftCount === CONFIG.images,
      're-running after an interrupted import finishes the job',
      `${afterResume.draftCount} of ${CONFIG.images}`,
    );
    check(
      findDuplicateKeys(afterResume).length === 0,
      'the retry duplicated nothing',
      `${findDuplicateKeys(afterResume).length} duplicated keys`,
    );
    check(
      (resumed.reported?.created ?? 0) === CONFIG.images - midway.draftCount,
      'the retry reports only the receipts it actually added',
      `reported ${resumed.reported?.created}, actually missing ${CONFIG.images - midway.draftCount}`,
    );
  }
  finish();

  // ── 6. things that go wrong must end, visibly ─────────────────────────────
  scenario('S6', 'Every failure mode reaches a clear terminal state — never a spinner');
  await resetLedger(db, ORG.orgId);
  ocr.reset();

  // 6a — corrupt archive
  const corrupt = Buffer.concat([Buffer.from('PK'), Buffer.alloc(4096, 0x41)]);
  if (primary === TRANSPORT_ZIP) {
    const res = await importArchive(TRANSPORT_ZIP, { baseUrl, cookie: session.header, zipBuffer: corrupt });
    check(
      res.status >= 400 && res.status < 500 && typeof res.body?.error === 'string',
      'a corrupt archive is refused with a readable message',
      `${res.status} ${res.body?.error ?? res.body?.raw ?? ''}`.slice(0, 160),
    );
  } else {
    // Under the per-item transport the archive is expanded in the BROWSER, so
    // a corrupt archive never reaches the server at all — it must fail in the
    // reader. The browser leg (scenario S8) is where that is proven; here we
    // only confirm the server rejects nonsense it is handed directly.
    const form = new FormData();
    form.set('file', new File([corrupt], 'broken.zip', { type: 'application/zip' }));
    form.set('batchId', crypto.randomUUID());
    const res = await fetch(`${baseUrl}/api/ingest/item`, {
      method: 'POST',
      headers: { cookie: session.header },
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    check(
      res.ok && body.item?.outcome === 'skipped',
      'a non-receipt file posted as an item is skipped with a reason, not accepted',
      `${res.status} ${body.item?.outcome} ${body.item?.reason ?? ''}`.slice(0, 160),
    );
  }

  // 6b — an archive with a mixture of everything that can go wrong
  const messy = buildWhatsappExport({
    images: Math.max(3, Math.round(CONFIG.images / 12)),
    totalBytes: Math.round(1.5 * 1024 * 1024),
    seed: 7,
    startIndex: 5000,
    extras: ['voice', 'video', 'fake-jpeg', 'huge-jpeg'],
  });
  if (primary === TRANSPORT_ZIP) edge.setEnabled(false);
  const messyResult = await importArchive(primary, {
    baseUrl,
    cookie: session.header,
    zipBuffer: messy.zip,
    archiveName: 'messy.zip',
  });
  edge.setEnabled(true);
  const messyFacts = await ledgerFacts(db, ORG.orgId);
  // The 6 MB photo is over the per-ITEM cap that only exists on the per-item
  // transport; the single-request zip route has no per-file ceiling at all, so
  // there it legitimately imports. Both are correct — the expectation, not the
  // product, has to know which transport is running.
  const oversizedIsSkipped = primary === TRANSPORT_ITEM;
  const expectedLanded = messy.manifest.photoCount + (oversizedIsSkipped ? 0 : 1);
  check(
    messyFacts.draftCount === expectedLanded,
    'the good receipts in a messy archive still land',
    `${messyFacts.draftCount} of ${expectedLanded} importable photos`,
  );
  const skippedCount = messyResult.reported?.skipped ?? 0;
  check(
    skippedCount >= (oversizedIsSkipped ? 4 : 3),
    'the voice note, the video, the fake image (and, where a per-file cap applies, the oversized photo) are reported as skipped',
    `${skippedCount} skipped`,
    messyResult.perItem?.filter((r) => r.body?.item?.outcome === 'skipped').map((r) => r.body.item) ??
      messyResult.body?.report?.skipped,
  );
  if (!oversizedIsSkipped) {
    info(
      'the single-request zip route has no per-file size cap',
      'a 6 MB photo inside the archive is accepted and OCR is paid for it; only the 100 MB ' +
        'archive-wide cap applies. The per-item transport adds a 4 MB per-file limit.',
    );
  }

  // 6c — path traversal must be refused, and must not be quietly repaired
  const hostile = buildWhatsappExport({ images: 1, totalBytes: 150 * 1024, seed: 11, extras: ['traversal'] });
  if (primary === TRANSPORT_ZIP) {
    const res = await importArchive(TRANSPORT_ZIP, { baseUrl, cookie: session.header, zipBuffer: hostile.zip });
    check(
      res.status === 422 && res.body?.code === 'PATH_TRAVERSAL',
      'an archive containing ../escape.jpg is refused outright',
      `${res.status} ${res.body?.code}`,
    );
  } else {
    const form = new FormData();
    form.set('file', new File([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], '../escape.jpg'));
    form.set('batchId', crypto.randomUUID());
    const res = await fetch(`${baseUrl}/api/ingest/item`, {
      method: 'POST',
      headers: { cookie: session.header },
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    check(
      res.status === 422 && body.code === 'INVALID_NAME',
      'an entry named ../escape.jpg is refused outright',
      `${res.status} ${body.code ?? ''}`,
    );
  }

  // 6d — OCR outage: the import must end with named failures, not hang
  await resetLedger(db, ORG.orgId);
  ocr.reset();
  ocr.configure({ failEveryNth: 1 });
  if (primary === TRANSPORT_ZIP) edge.setEnabled(false);
  const outageArchive = buildWhatsappExport({ images: 4, totalBytes: 600 * 1024, seed: 21, startIndex: 6000 });
  const outage = await importArchive(primary, {
    baseUrl,
    cookie: session.header,
    zipBuffer: outageArchive.zip,
    archiveName: 'ocr-outage.zip',
  });
  ocr.configure({ failEveryNth: 0 });
  edge.setEnabled(true);
  const outageFacts = await ledgerFacts(db, ORG.orgId);
  check(
    (outage.reported?.failed ?? 0) === 4 || outageFacts.draftCount === 0,
    'a total OCR outage ends the run with named failures rather than silence',
    `reported failed=${outage.reported?.failed}, drafts created=${outageFacts.draftCount}`,
    outage.reported,
  );
  check(
    outageFacts.draftCount === 0,
    'nothing unreadable was written to the books',
    `${outageFacts.draftCount} rows`,
  );

  // 6e — OCR returning a zero amount must not become a zero-value journal entry
  await resetLedger(db, ORG.orgId);
  ocr.reset();
  ocr.configure({ zeroAmountNth: 1 });
  if (primary === TRANSPORT_ZIP) edge.setEnabled(false);
  const zeroArchive = buildWhatsappExport({ images: 3, totalBytes: 450 * 1024, seed: 31, startIndex: 7000 });
  const zeroRun = await importArchive(primary, {
    baseUrl,
    cookie: session.header,
    zipBuffer: zeroArchive.zip,
    archiveName: 'zero-amount.zip',
  });
  ocr.configure({ zeroAmountNth: 0 });
  edge.setEnabled(true);
  const zeroFacts = await ledgerFacts(db, ORG.orgId);
  const zeroValued = [...zeroFacts.linesByEntry.values()].flat().filter((l) => Number(l.amount) <= 0);
  check(
    zeroValued.length === 0,
    'a receipt OCR could not price never becomes a zero-value journal entry',
    `${zeroValued.length} zero/negative ledger lines; ${zeroFacts.draftCount} entries created`,
    { reported: zeroRun.reported },
  );

  // 6f — expired session
  await resetLedger(db, ORG.orgId);
  ocr.reset();
  if (primary === TRANSPORT_ITEM) {
    const half = Math.max(2, Math.floor(CONFIG.images / 6));
    const expiredRun = await uploadPerItem({
      baseUrl,
      cookie: session.header,
      zipBuffer: buildWhatsappExport({ images: half * 2, totalBytes: 2 * 1024 * 1024, seed: 41, startIndex: 8000 }).zip,
      concurrency: 1,
      archiveName: 'expired-session.zip',
      cookieForItem: (postedSoFar) => (postedSoFar >= half ? expired.header : session.header),
    });
    const unauthorised = expiredRun.perItem.filter((r) => r.status === 401);
    check(
      unauthorised.length > 0,
      'an expired session stops the import with a 401 rather than silently dropping receipts',
      `${unauthorised.length} of ${expiredRun.perItem.length} uploads were rejected as unauthenticated`,
    );
    const expiredFacts = await ledgerFacts(db, ORG.orgId);
    check(
      expiredFacts.draftCount === expiredRun.liveTally.created,
      'the receipts accepted before the session died are exactly the ones in the books',
      `${expiredFacts.draftCount} rows vs ${expiredRun.liveTally.created} reported created`,
    );
  } else {
    const res = await importArchive(TRANSPORT_ZIP, {
      baseUrl,
      cookie: expired.header,
      zipBuffer: buildWhatsappExport({ images: 2, totalBytes: 300 * 1024, seed: 41 }).zip,
    });
    check(
      res.status === 401,
      'an expired session is refused with 401, not left hanging',
      `→ ${res.status}`,
    );
  }
  finish();

  // ── 7. rate limiter under a legitimate bulk run ───────────────────────────
  if (primary === TRANSPORT_ITEM) {
    scenario('S7', 'Does the per-organisation rate limiter throttle a legitimate bulk import?');
    await resetLedger(db, ORG.orgId);
    ocr.reset();
    ocr.configure({ latencyMs: 0 });
    const burst = buildWhatsappExport({ images: Math.min(120, CONFIG.images), totalBytes: 8 * 1024 * 1024, seed: 51, startIndex: 9000 });
    const started = Date.now();
    const run = await uploadPerItem({
      baseUrl,
      cookie: session.header,
      zipBuffer: burst.zip,
      archiveName: 'burst.zip',
    });
    ocr.configure({ latencyMs: CONFIG.ocrLatencyMs });
    const elapsed = Date.now() - started;
    const throttled = run.perItem.filter((r) => r.status === 429).length;
    const burstFacts = await ledgerFacts(db, ORG.orgId);
    info(
      'fast-OCR bulk run',
      `${burst.manifest.photoCount} photos in ${secs(elapsed)}, ${throttled} exhausted the 429 retry budget`,
    );
    check(
      burstFacts.draftCount === burst.manifest.photoCount,
      'a fast bulk import still lands every receipt despite the rate limiter',
      `${burstFacts.draftCount} of ${burst.manifest.photoCount}`,
    );
    check(
      (run.reported?.created ?? -1) === burstFacts.draftCount,
      'the reported count is still true under throttling',
      `reported ${run.reported?.created}, database ${burstFacts.draftCount}`,
    );
    finish();
  }

  // ── 8. a real browser ──────────────────────────────────────────────────────
  if (!CONFIG.skipBrowser) {
    scenario('S8', 'A real Chromium browser drives the actual upload UI');
    try {
      const { runBrowserLeg } = await import('./browser.mjs');
      await runBrowserLeg({
        baseUrl,
        cookie: session,
        db,
        orgId: ORG.orgId,
        archive: buildWhatsappExport({
          images: Math.max(3, Math.round(CONFIG.images / 20)),
          totalBytes: 900 * 1024,
          seed: 61,
          startIndex: 11_000,
        }),
        outDir: CONFIG.outDir,
        check,
        info,
        warn,
        resetLedger: () => resetLedger(db, ORG.orgId),
        ledgerFacts: () => ledgerFacts(db, ORG.orgId),
      });
    } catch (err) {
      warn('the browser leg could not run', String(err?.message ?? err));
    }
    finish();
  }
}

/**
 * The exact bytes of one photo inside a generated archive, cached per archive.
 * Used to compute the ledger total the stub OCR will produce, so the harness
 * knows the right answer before it uploads anything.
 */
/** Every reason the server gave for refusing a receipt, whichever transport ran. */
function collectFailureReasons(result) {
  const fromZip = (result.body?.report?.failures ?? []).map((f) => `${f.name}: ${f.error}`);
  const fromItems = (result.perItem ?? [])
    .map((r) => r.body?.item)
    .filter((item) => item && (item.outcome === 'failed' || item.outcome === 'skipped'))
    .map((item) => `${item.name}: ${item.reason ?? item.stage ?? 'unknown'}`);
  return [...fromZip, ...fromItems];
}

const entryCaches = new WeakMap();
function photoBytesFor(built, name) {
  let cache = entryCaches.get(built);
  if (!cache) {
    cache = new Map(expandArchive(built.zip).map((e) => [e.name, e.data]));
    entryCaches.set(built, cache);
  }
  return cache.get(name) ?? Buffer.alloc(0);
}

// ── report ───────────────────────────────────────────────────────────────────

const NOT_COVERED = [
  'The real Google OAuth sign-in. The harness mints the same session cookie the app mints, using ' +
    'the app\'s own Auth.js code and a throwaway local secret, so every request is authenticated for ' +
    'real — but the consent screen, the AUTH_ALLOWED_EMAILS allow-list and the User upsert only run ' +
    'during sign-in and are never exercised here.',
  'The real OCR microservice. It is stubbed, deterministically, so the expected ledger total is ' +
    'knowable in advance. Accuracy of extraction, its latency under real load, and its own outages ' +
    'beyond the injected ones are not tested.',
  'Vercel itself. The ~4.5 MB request-body ceiling is SIMULATED by a local proxy that reproduces the ' +
    'documented behaviour. Cold starts, the 60s function timeout, regional routing and Vercel\'s own ' +
    'error pages are not reproduced. A staging deployment is still required before go-live.',
  'The production database. By construction — the harness refuses any non-local, non-disposable ' +
    'database, and creates only the four rows an import needs (org, user, membership, two accounts).',
  'Real photographs. The generated JPEGs are structurally valid and decode in Chromium, but they are ' +
    'flat grey with random comment padding, not pictures of receipts.',
  'Concurrent operators. Everything runs as one signed-in user in one organisation.',
];

async function writeReport(startedAt, server) {
  const fails = findings.filter((f) => f.severity === 'FAIL');
  const warns = findings.filter((f) => f.severity === 'WARN');
  const totalChecks = scenarios.reduce((n, s) => n + s.checks.length, 0);
  const passed = scenarios.reduce((n, s) => n + s.checks.filter((c) => c.ok).length, 0);

  log('\n════════════════════════════════════════════════════════════════');
  log(` RESULT: ${passed}/${totalChecks} checks passed, ${fails.length} failures, ${warns.length} warnings`);
  log(`         run took ${secs(Date.now() - startedAt)}`);
  log('════════════════════════════════════════════════════════════════');

  if (fails.length) {
    log('\nFAILURES');
    for (const f of fails) log(`  • [${f.scenario}] ${f.title}\n      ${f.detail ?? ''}`);
  }
  if (warns.length) {
    log('\nWARNINGS');
    for (const f of warns) log(`  • [${f.scenario}] ${f.title}\n      ${f.detail ?? ''}`);
  }

  log('\nWHAT THIS RUN DID NOT COVER');
  for (const item of NOT_COVERED) log(`  • ${item}`);

  const report = {
    startedAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    config: CONFIG,
    scenarios,
    findings,
    notCovered: NOT_COVERED,
  };
  const file = path.join(CONFIG.outDir, 'report.json');
  await writeFile(file, JSON.stringify(report, null, 2));
  if (fails.length && server) {
    await writeFile(path.join(CONFIG.outDir, 'server.log'), server.serverLog());
  }
  log(`\nfull report: ${file}`);
}

main().catch(async (err) => {
  console.error('\nHARNESS ABORTED:', err);
  process.exitCode = 1;
});

/**
 * The browser leg: a real Chromium, the real page, a real file picker.
 *
 * Why this is separate from the HTTP scenarios: about half of the import now
 * happens in the browser. On PR #133 the ARCHIVE IS EXPANDED CLIENT-SIDE, so a
 * harness that only speaks HTTP tests the half of the feature the operator's
 * laptop does not run. Things that can only fail here:
 *
 *   • the uploader never leaving "Uploading…" (the indefinite spinner)
 *   • the browser failing to read the zip at all
 *   • the page reporting a number that differs from what the server recorded
 *   • an unhandled exception in the client bundle
 *
 * Playwright is expected to be available in the environment (or installed
 * globally); if it is not, the caller records that as an uncovered layer
 * rather than a pass.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);

/** Resolve Playwright from the project OR from a global install. */
function loadPlaywright() {
  const candidates = ['playwright', 'playwright-core', '/opt/node22/lib/node_modules/playwright'];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('playwright is not installed — the browser leg cannot run');
}

/**
 * The uploader has finished when its OWN card shows a result or an error.
 *
 * Scoped to the card, not the page: /sandbox renders other live regions (the
 * Action Centre, the staging panel), and matching those made a first version
 * of this leg report "finished in 0.0s" against an empty element — a false
 * pass of exactly the kind this project exists to eliminate.
 */
const TERMINAL_SELECTOR = '[role="status"], [role="alert"]';

export async function runBrowserLeg({
  baseUrl,
  cookie,
  archive,
  outDir,
  check,
  info,
  warn,
  resetLedger,
  ledgerFacts,
}) {
  const { chromium } = loadPlaywright();
  const launchOptions = { headless: true };
  const browser = await chromium.launch(launchOptions).catch(async (err) => {
    // A pinned-version mismatch is recoverable: the environment ships a
    // Chromium at a known path.
    warn('default Chromium launch failed, retrying with the environment browser', String(err?.message ?? err));
    return chromium.launch({ ...launchOptions, executablePath: '/opt/pw-browsers/chromium' });
  });

  const context = await browser.newContext();
  const url = new URL(baseUrl);
  await context.addCookies([
    {
      name: cookie.name,
      value: cookie.value,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);

  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err?.message ?? err)));

  try {
    await resetLedger();

    // First, the generated JPEGs must actually decode — otherwise the whole
    // fixture is a lie and every other assertion is worthless.
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    const sample = archive.manifest.photos[0];
    const bytes = sampleBytes(archive, sample.name);
    const decoded = await page.evaluate(
      (b64) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => resolve({ ok: false });
          img.src = `data:image/jpeg;base64,${b64}`;
        }),
      bytes.toString('base64'),
    );
    check(
      decoded.ok === true,
      'the generated receipt photos are genuinely decodable JPEGs',
      decoded.ok ? `${decoded.w}x${decoded.h}` : 'Chromium refused to decode the fixture',
    );

    const response = await page.goto(`${baseUrl}/sandbox`, { waitUntil: 'domcontentloaded' });
    check(
      response?.status() === 200 && !page.url().includes('/login'),
      'the signed-in session reaches the upload page in a real browser',
      `${response?.status()} ${page.url()}`,
    );

    const fileInput = page.locator('input[type="file"][accept*="zip"]').first();
    const hasUploader = (await fileInput.count()) > 0;
    if (!hasUploader) {
      warn(
        'no zip uploader is rendered on /sandbox in this build',
        'the browser leg cannot exercise the UI path; the HTTP scenarios still apply',
      );
      return;
    }

    const zipPath = path.join(outDir, 'browser-archive.zip');
    await writeFile(zipPath, archive.zip);

    const started = Date.now();
    await fileInput.setInputFiles(zipPath);

    // The single most important UI property: the uploader must ALWAYS reach a
    // terminal state. A timeout here IS the indefinite-spinner bug.
    //
    // The wait walks up from the file input to the nearest ancestor that also
    // holds a non-empty live region, rather than matching class names or the
    // first [role=status] on the page. /sandbox has other live regions, and a
    // page-wide match made an earlier version of this leg report "finished in
    // 0.0s" against an empty element belonging to a different component.
    const readOutcome = () =>
      page.evaluate(
        ({ selector }) => {
          const input = document.querySelector('input[type="file"][accept*="zip"]');
          if (!input) return null;
          for (let node = input.parentElement; node; node = node.parentElement) {
            for (const region of node.querySelectorAll(selector)) {
              const text = (region.textContent ?? '').trim();
              if (text.length > 0) return { text, role: region.getAttribute('role') };
            }
          }
          return null;
        },
        { selector: TERMINAL_SELECTOR },
      );

    let outcome = null;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      outcome = await readOutcome();
      if (outcome) break;
      await page.waitForTimeout(500);
    }
    const terminal = outcome !== null;
    check(
      terminal,
      'the uploader reaches a visible finished-or-failed state (never an endless spinner)',
      terminal ? `after ${((Date.now() - started) / 1000).toFixed(1)}s` : 'still spinning after 180s',
    );

    const shownText = outcome?.text ?? '';
    info('what the operator is shown', shownText.split('\n')[0]?.slice(0, 200) ?? '(nothing)');

    const facts = await ledgerFacts();
    // "N draft entries created" / "N receipts imported" — whichever wording the
    // build uses, the NUMBER has to match the database.
    const claimed = Number(shownText.match(/(\d+)\s+(?:draft|receipt|entr)/i)?.[1] ?? NaN);
    if (Number.isFinite(claimed)) {
      check(
        claimed === facts.draftCount,
        'the number the page shows equals the number of rows in the database',
        `page says ${claimed}, database has ${facts.draftCount}`,
      );
    } else if (terminal) {
      warn(
        'the page did not state a receipt count in a readable form',
        `could not parse a count from: ${shownText.slice(0, 160)}`,
      );
    }
    check(
      facts.draftCount === archive.manifest.photoCount || !terminal,
      'a browser-driven upload puts every receipt in the books',
      `${facts.draftCount} of ${archive.manifest.photoCount}`,
    );

    await page.screenshot({ path: path.join(outDir, 'uploader.png'), fullPage: true }).catch(() => {});

    check(
      pageErrors.length === 0,
      'the client bundle threw no unhandled exceptions during the import',
      pageErrors.slice(0, 3).join(' | '),
    );
    if (consoleErrors.length > 0) {
      warn('the browser console logged errors during the import', consoleErrors.slice(0, 3).join(' | '));
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

const cache = new WeakMap();
function sampleBytes(archive, name) {
  let map = cache.get(archive);
  if (!map) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(archive.zip);
    map = new Map(zip.getEntries().map((e) => [e.entryName, e.getData()]));
    cache.set(archive, map);
  }
  return map.get(name) ?? Buffer.alloc(0);
}

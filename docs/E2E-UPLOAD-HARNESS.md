# The receipt-import end-to-end harness

## Why it exists

BookLets had 720 passing unit tests while the WhatsApp receipt import had
**never once worked in production**. `public."JournalEntry"` had zero rows.

The reason those tests could not catch it is simple and worth stating plainly:
every unit test replaces the network with a stand-in, and the network was the
broken part. The hosting platform rejects any request body over about 4.5 MB
*before* the application code runs, and a real WhatsApp "Export Chat → Attach
Media" archive is tens of megabytes. `POST /api/ingest/zip` was never reached.

This harness is built so that class of failure cannot hide again. It generates a
real archive, uploads it over real HTTP to a real build of the application,
through a proxy that enforces the same request-body ceiling the platform
enforces — and then checks **the database**, never the application's own report
of what it did.

## How to run it

```bash
npm run e2e            # full scale: ~120 photos, ~28.5 MB — the operator's real case
npm run e2e:quick      # ~24 photos, ~6 MB — a fast signal
```

Useful flags (pass them after the script name, e.g. `npm run e2e -- --quick`):

| Flag | What it does |
| --- | --- |
| `--images=N` | number of photos in the archive |
| `--total-mb=N` | target total photo payload |
| `--ocr-latency=MS` | how slow the stubbed OCR service is (default 400 ms) |
| `--skip-build` | reuse the existing `.next` build (much faster to iterate) |
| `--no-browser` | skip the Chromium leg |
| `--port=N` | base port; the harness uses N, N+1 and N+2 |
| `--keep-db` | leave the throwaway Postgres running afterwards |

It needs no configuration. It provisions its own Postgres (Docker if a daemon is
running, otherwise a throwaway local cluster), applies the schema and the raw-SQL
migrations, builds the app, serves it, and tears everything down at the end.

Artefacts — the generated archive, a screenshot, `report.json`, and the server log
if anything failed — go into a fresh private directory created with `mkdtemp`
(mode 0700, unguessable name). The path is printed at the start and end of every
run. It is deliberately not a fixed location like `/tmp/booklets-e2e`: on a shared
machine or a multi-tenant CI runner, a guessable path can be pre-created or
symlinked by another user and everything written follows the link. Pass `--out`
to pin the directory yourself; it is still forced to 0700, because the server log
can carry environment detail.

To point it at an existing disposable database:

```bash
E2E_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/booklets_e2e npm run e2e
```

You can also just generate an archive, without running anything:

```bash
npm run e2e:make-export -- --out /tmp/export.zip --images 120 --total-mb 28.5
```

## Where it belongs

**Not in the default CI path.** It builds the application, starts a database and a
web server, and a full-scale run takes minutes. Put it on a nightly schedule, or
run it by hand before a release and after any change to the upload transport,
the ledger write path, or the dedup key. `npm run test:unit` stays the fast gate.

## Safety

The harness writes journal entries, so it refuses to run anywhere it might do
damage. `assertDisposableDatabase` requires the database host to be local
*and* the database name to contain `test`, `e2e` or `harness`. There is no
override flag. It never runs `prisma db seed`; it inserts exactly the rows an
import needs (one organisation, one user, one membership, two accounts, one
fiscal period) and nothing else.

## What it covers

| Area | What is actually proven |
| --- | --- |
| Platform ceiling | A 28.5 MB single-request upload is rejected before the app runs, and nothing reaches the books — the production bug, reproduced on demand |
| Framework ceiling | A 12 MB upload with the platform edge out of the way: Next buffers a clone of every body when a `proxy.ts` exists and silently truncates past `experimental.proxyClientMaxBodySize` (10 MB by default). The check is that a valid archive is never reported back as a corrupt one |
| Cold start | Whether a freshly deployed organisation, configured the way production is, can import a receipt at all |
| Scale | A full ~120-photo, ~28.5 MB import end to end: duration, OCR fan-out, and whether the rate limiter throttles a legitimate bulk run |
| Truthfulness | The number shown to the operator equals the DRAFT rows in the database, and equals the permanent audit record |
| Money | Every entry is a balanced double-entry pair, no zero or negative lines, and the ledger total equals the sum the receipts stated |
| Dedup | Re-importing the same archive creates nothing and spends no OCR; an overlapping archive adds only the genuinely new receipts — both checked in SQL |
| Interruption | Killing a run midway leaves the completed work in the database, and re-running finishes it without duplicating |
| Failure surfacing | Corrupt archive, non-image file, voice note, video, oversized photo, path traversal, total OCR outage, unpriceable receipt, an OCR call that never answers, expired session — each must reach a clear terminal state |
| Races | The same archive submitted twice simultaneously: each receipt must be created exactly once, and the two runs together must not claim more than exists |
| Browser | A real Chromium loads `/sandbox`, uploads through the real file input, and must reach a visible finished-or-failed state; the count on screen is compared to the database |

Every assertion is made against Postgres. The application's response is recorded
as evidence, never trusted as truth.

## What it does NOT cover

This list is printed at the end of every run as well, so it cannot rot silently.

- **Google sign-in.** The harness mints the session cookie using Auth.js's own
  `encode()` and the throwaway local `AUTH_SECRET` of the instance it just
  started. Every request is then authenticated by the real proxy, the real
  `auth()` and the real membership lookup. What is *not* exercised is the
  consent screen, the `AUTH_ALLOWED_EMAILS` allow-list and the `User` upsert —
  those run only during sign-in. (The app uses JWT sessions, not database
  sessions, so there is no session row to insert instead.)
- **The OCR microservice.** Stubbed, deterministically, so the expected ledger
  total is known before anything is uploaded. Extraction accuracy, real latency
  and the service's own outages are not tested. Injected failures, zero amounts
  and hangs are.
- **Vercel itself.** The ~4.5 MB body ceiling is simulated by a local proxy
  reproducing the documented behaviour, including the plain-text (not JSON)
  error body. Cold starts, the 60-second function timeout, regional routing and
  Vercel's own error pages are not reproduced. **A staging deployment is still
  required before go-live.**
- **Real photographs.** The generated JPEGs are structurally valid and decode in
  Chromium — the harness verifies that — but they are flat grey with random
  comment padding, not pictures of receipts. Use `--media-dir` with real photos
  if you ever point this at a live OCR service.
- **Concurrency between people.** One signed-in user, one organisation.
- **Approval and posting.** The harness stops where the import stops: at DRAFT.
  It asserts nothing is POSTED, but does not exercise four-eyes approval.

## How it is put together

```
scripts/e2e/
  whatsapp-export.mjs   generates the archive (also a standalone CLI)
  jpeg.mjs              builds genuinely decodable JPEGs at realistic sizes
  stubs.mjs             the OCR stand-in and the platform-edge simulator
  session.mjs           mints the session cookie with the app's own Auth.js code
  env.mjs               Postgres, schema, migrations, build, serve, tear down
  db.mjs                ground truth: SQL, and only SQL
  transports.mjs        drives whichever upload route the build serves
  browser.mjs           the real-Chromium leg
  run.mjs               the scenarios and the report
```

Two design decisions are worth knowing about:

**The archive is deterministic by seed, and a photo's bytes depend only on its
sequence number.** "Photo 31" is byte-identical in every archive that contains
photo 31. Without that, an "overlapping export" is not overlapping, and the dedup
scenarios would silently pass while testing nothing. (That was a real bug in the
first version of the generator, found by the overlap scenario itself.)

**The harness detects which upload route the build serves.** Before PR #133 the
only route was the single-request `/api/ingest/zip`; #133 added per-entry uploads
to `/api/ingest/item` plus `/api/ingest/batch` and left the zip route in place for
small archives. Scenarios are written against the user-visible outcome — "N
receipts became N drafts" — so the same suite runs against either, and says which
one it found. That is what let it run unchanged across #133 landing mid-build.

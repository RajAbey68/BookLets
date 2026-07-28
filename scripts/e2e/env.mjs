/**
 * Bring up a disposable, self-contained copy of the application.
 *
 * Layers, outermost first:
 *
 *   client → edge proxy (:PORT)  → next start (:PORT+1) → Postgres
 *                                → OCR stub (:PORT+2)
 *
 * The edge proxy exists because the production failure this harness was built
 * to catch happened at a layer `next start` does not have (see stubs.mjs).
 *
 * SAFETY. This module refuses to run against anything that is not obviously a
 * disposable local database. The check is deliberately blunt — a harness that
 * writes 120 fake receipts into the real books would be far worse than no
 * harness at all.
 */
import { spawn } from 'node:child_process';
import { chmod, chown, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Hard stop on anything that could be production.
 *
 * Local-only hosts and a database name that says out loud that it is a test
 * database. There is no override flag, on purpose.
 */
export function assertDisposableDatabase(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(`E2E refuses to run: DATABASE_URL is not a URL (${databaseUrl}).`);
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  if (!localHosts.has(url.hostname)) {
    throw new Error(
      `E2E refuses to run against host "${url.hostname}". This harness writes ` +
        'journal entries; it may only ever point at a local, disposable database.',
    );
  }
  const dbName = url.pathname.replace(/^\//, '');
  if (!/(test|e2e|harness)/i.test(dbName)) {
    throw new Error(
      `E2E refuses to run against database "${dbName}". Name it so it is obviously ` +
        'disposable (must contain "test", "e2e" or "harness").',
    );
  }
  return true;
}

/**
 * Create the directory this run writes its artefacts into: the generated
 * archive, report.json, the server log, and the browser screenshot.
 *
 * NOT a fixed path under the system temp directory. `/tmp/booklets-e2e` is
 * guessable, so on a shared machine or a multi-tenant CI runner another user
 * can pre-create it — or plant a symlink at `report.json` — and everything the
 * harness writes follows the link (CWE-377/378, CodeQL js/insecure-temporary-file).
 * `mkdtemp` gives an unguessable name, created 0700 and owned by us.
 *
 * An explicit `--out` is the operator's own decision about where the files go,
 * so it is honoured — but still forced to 0700, because the server log can
 * carry environment detail.
 */
export async function createArtifactDir(explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    await chmod(resolved, 0o700);
    return resolved;
  }
  return mkdtemp(path.join(os.tmpdir(), 'booklets-e2e-'));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe', ...options });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => {
      out += d;
    });
    child.stderr?.on('data', (d) => {
      err += d;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${command} ${args.map(redactSecrets).join(' ')} exited ${code}\n${redactSecrets(err || out)}`)),
    );
  });
}

/**
 * Strip credentials out of anything about to be printed.
 *
 * `psql` is invoked with a full connection URL in argv, and the failure path
 * formats argv into the rejection message — which lands in the console, in
 * report.json, and in CI logs. A local harness password is not a catastrophe,
 * but leaking whatever is in DATABASE_URL because a command exited non-zero is
 * a bad habit to build into shared tooling.
 */
function redactSecrets(text) {
  return String(text).replace(/(\w+:\/\/[^:@\s/]+):[^@\s/]+@/g, '$1:***@');
}

/**
 * Resolve the `postgres` account's uid/gid, or null when we are not root.
 *
 * Used to DROP PRIVILEGES via spawn's own uid/gid options rather than shelling
 * out to `su postgres -c "<command string>"`. `su -c` takes a command STRING,
 * which means every path in it is concatenated into something a shell parses —
 * and those paths come from os.tmpdir(), i.e. from TMPDIR. That is a real
 * injection shape (CodeQL js/indirect-command-line-injection) even in test
 * tooling, and there is no reason to accept it when spawn can drop privileges
 * directly with no shell in the picture.
 */
async function resolvePostgresUser() {
  if (process.getuid?.() !== 0) return null;
  try {
    const uid = Number((await run('id', ['-u', 'postgres'])).trim());
    const gid = Number((await run('id', ['-g', 'postgres'])).trim());
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
    return { uid, gid };
  } catch {
    return null;
  }
}

/** Postgres refuses to run as root, so identifiers get a strict shape check. */
function assertSafeDatabaseName(database) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database)) {
    throw new Error(`Refusing to use "${database}" as a database name: not a plain SQL identifier.`);
  }
  return database;
}

/**
 * Provision Postgres. Prefers Docker (matching `npm run test:integration:setup`
 * so the two lanes behave the same on a developer laptop); falls back to a
 * throwaway local cluster via initdb when there is no Docker daemon, which is
 * what CI sandboxes and cloud dev boxes usually have.
 */
export async function startPostgres({ port = 55432, database = 'booklets_e2e', log = console.log }) {
  assertSafeDatabaseName(database);
  // `port` is interpolated into pg_ctl's -o string, which `postgres` re-parses
  // as options. An integer cannot inject anything; anything else might.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Refusing to start Postgres on "${port}": not a valid port number.`);
  }
  const url = `postgresql://postgres@127.0.0.1:${port}/${database}`;

  // `docker info` both proves the binary exists (spawn rejects ENOENT) and that
  // the daemon is reachable — one probe instead of a `command -v` shell call.
  const dockerUp = await run('docker', ['info']).then(() => true, () => false);
  if (dockerUp) {
    const name = 'booklets-e2e-pg';
    const exists = await run('docker', ['inspect', name]).then(() => true, () => false);
    if (!exists) {
      log(`[env] starting docker postgres "${name}" on :${port}`);
      await run('docker', [
        'run', '-d', '--name', name,
        '-e', 'POSTGRES_PASSWORD=test',
        '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
        '-e', `POSTGRES_DB=${database}`,
        '-p', `${port}:5432`,
        'postgres:16-alpine',
      ]);
    } else {
      await run('docker', ['start', name]).catch(() => {});
    }
    // A readiness loop that falls through when its budget runs out hands the
    // caller a database that never came up, and every "test" after that is
    // noise wearing the costume of a result. Never proceed unready.
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      ready = await run('docker', ['exec', name, 'pg_isready', '-U', 'postgres']).then(() => true, () => false);
      if (!ready) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ready) {
      throw new Error(
        `Docker Postgres "${name}" did not accept connections within 60s. The harness will not run ` +
          'against a database that never started.',
      );
    }
    // Match the local-cluster branch: create the database we were asked for
    // rather than depending on POSTGRES_DB, which only takes effect on a
    // container's FIRST start and silently does nothing on a reused one.
    await run('docker', [
      'exec', name, 'psql', '-U', 'postgres', '-c', `CREATE DATABASE "${database}"`,
    ]).catch(() => {
      /* already exists — the only expected failure here */
    });
    return { url, kind: 'docker', async stop() { /* container is reused between runs */ } };
  }

  // No Docker daemon: run a throwaway cluster straight off the postgres binaries.
  const binDirs = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/pgsql/bin'];
  const binDir = binDirs.find((dir) => existsSync(path.join(dir, 'initdb')));
  if (!binDir) {
    throw new Error(
      'No Docker daemon and no local Postgres binaries found. Start Docker, or set ' +
        'E2E_DATABASE_URL to a disposable local database the harness may write to.',
    );
  }
  // mkdtemp creates the directory 0700 and owned by us, with an unguessable
  // suffix — no other user can pre-create or symlink it out from under us.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'booklets-e2e-pg-'));

  // Drop privileges through spawn, never through a shell.
  const pgUser = await resolvePostgresUser();
  const asPg = pgUser ? { uid: pgUser.uid, gid: pgUser.gid } : {};
  if (pgUser) await chown(dataDir, pgUser.uid, pgUser.gid);

  log(`[env] initialising local postgres cluster in ${dataDir}`);
  await run(path.join(binDir, 'initdb'), ['-D', dataDir, '-U', 'postgres', '--auth=trust'], asPg);
  await run(
    path.join(binDir, 'pg_ctl'),
    [
      '-D', dataDir,
      /**
       * `-o` is ONE argv element, but that is not the whole story: pg_ctl hands
       * this string on to `postgres`, which parses it AGAIN as command-line
       * options. That second parsing boundary is the hazard — anything
       * interpolated here that could contain a space injects extra PostgreSQL
       * flags, no shell required.
       *
       * So NOTHING path-shaped goes in here. An earlier version passed
       * `-k ${runDir}` (a private Unix-socket directory under os.tmpdir(), i.e.
       * derived from TMPDIR); a TMPDIR containing a space would have split it.
       * The socket directory was never used — every connection in this harness
       * is TCP to 127.0.0.1, including pg_ctl's own readiness wait and the psql
       * calls below — so it is simply gone. `port` is asserted to be an integer
       * above, and the rest is a literal.
       */
      '-o', `-p ${port} -c listen_addresses=127.0.0.1`,
      '-l', path.join(dataDir, 'server.log'),
      'start',
    ],
    asPg,
  );
  await run(
    path.join(binDir, 'psql'),
    ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-c', `CREATE DATABASE "${database}"`],
    asPg,
  ).catch(() => {});

  return {
    url,
    kind: 'local-cluster',
    async stop() {
      await run(path.join(binDir, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', 'stop'], asPg).catch(() => {});
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** `prisma db push` plus the raw-SQL migrations Prisma cannot express. */
export async function applySchema(databaseUrl, { log = console.log } = {}) {
  log('[env] applying prisma schema');
  await run('npx', ['prisma', 'db', 'push', '--accept-data-loss'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  // Same set the integration lane applies, so the harness runs against the
  // same DB-level controls (fiscal lock, posted-entry immutability, RLS).
  // The single-tenant lock is deliberately included: if it ever blocked a
  // legitimate import that is a finding, not something to route around.
  const migrations = [
    '20260703_fiscal_lock_and_posted_delete_triggers',
    '20260712_rls_org_isolation',
    '20260716_single_tenant_lock',
  ];
  for (const name of migrations) {
    const file = path.join(REPO_ROOT, 'prisma', 'migrations', name, 'migration.sql');
    if (!existsSync(file)) {
      log(`[env] skipping migration ${name} (not present on this branch)`);
      continue;
    }
    log(`[env] applying migration ${name}`);
    // argv, not a shell string: databaseUrl comes from the environment.
    await run('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', file]);
  }
}

/**
 * Refuse to start if the port is already taken.
 *
 * Learned the hard way while building this: a leftover server from a previous
 * run happily answered the health check, and the harness then spent a whole
 * run testing the OLD build with the OLD secret. Silently testing the wrong
 * thing is precisely the failure this project is trying to stop.
 */
export async function assertPortFree(port, label) {
  const busy = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }).then(
    () => true,
    (err) => err?.name === 'TimeoutError',
  );
  if (busy) {
    throw new Error(
      `Port ${port} (${label}) is already in use. A previous harness run is probably still alive — ` +
        'stop it first, or pass --port=<free base port>.',
    );
  }
}

/** Build the app once, then serve it. Returns a handle that can kill it. */
export async function startNextServer({ port, databaseUrl, env, log = console.log, skipBuild = false }) {
  const buildEnv = { ...process.env, ...env, DATABASE_URL: databaseUrl, NODE_ENV: 'production' };
  if (!skipBuild) {
    log('[env] next build (this is the same build the deployment runs)');
    await run('npx', ['next', 'build'], { cwd: REPO_ROOT, env: buildEnv });
  }

  log(`[env] next start on :${port}`);
  // detached so the whole process group can be killed: `next start` spawns a
  // child server, and killing only the wrapper leaves it holding the port.
  const child = spawn('npx', ['next', 'start', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd: REPO_ROOT,
    env: buildEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const logLines = [];
  const capture = (d) => {
    const text = String(d);
    logLines.push(text);
    if (logLines.length > 4000) logLines.shift();
    if (process.env.E2E_VERBOSE) process.stdout.write(text);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  const base = `http://127.0.0.1:${port}`;
  // As with the database readiness loop: falling through on exhaustion would
  // hand every scenario a server that never came up, and they would then
  // "fail" for reasons that have nothing to do with the product. Refuse to
  // return anything but a server that answered.
  let serving = false;
  for (let i = 0; i < 120 && !serving; i += 1) {
    serving = await fetch(`${base}/api/health`).then((r) => r.status < 500, () => false);
    if (serving) break;
    if (child.exitCode !== null) throw new Error(`next start exited ${child.exitCode}\n${logLines.join('')}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!serving) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    throw new Error(
      `next start never answered /api/health on :${port} within 60s.\n${logLines.join('').slice(-4000)}`,
    );
  }

  return {
    port,
    base,
    serverLog: () => logLines.join(''),
    async stop() {
      const killGroup = (signal) => {
        try {
          process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            /* already gone */
          }
        }
      };
      killGroup('SIGTERM');
      await new Promise((r) => setTimeout(r, 800));
      if (child.exitCode === null) killGroup('SIGKILL');
    },
  };
}

/** Write the env file the harness instance runs with, for reproducibility. */
export async function writeRunEnv(file, env) {
  await writeFile(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}

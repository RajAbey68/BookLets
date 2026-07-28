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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
      code === 0 ? resolve(out) : reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${err || out}`)),
    );
  });
}

async function commandExists(command) {
  try {
    await run('sh', ['-c', `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Provision Postgres. Prefers Docker (matching `npm run test:integration:setup`
 * so the two lanes behave the same on a developer laptop); falls back to a
 * throwaway local cluster via initdb when there is no Docker daemon, which is
 * what CI sandboxes and cloud dev boxes usually have.
 */
export async function startPostgres({ port = 55432, database = 'booklets_e2e', log = console.log }) {
  const url = `postgresql://postgres@127.0.0.1:${port}/${database}`;

  const dockerUp = (await commandExists('docker')) && (await run('docker', ['info']).then(() => true, () => false));
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
    for (let i = 0; i < 60; i += 1) {
      const ready = await run('docker', ['exec', name, 'pg_isready', '-U', 'postgres']).then(() => true, () => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'booklets-e2e-pg-'));
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'booklets-e2e-sock-'));
  const asPostgres = process.getuid?.() === 0 ? ['su', 'postgres', '-c'] : null;
  const shellRun = async (cmd) => (asPostgres ? run(asPostgres[0], [asPostgres[1], asPostgres[2], cmd]) : run('sh', ['-c', cmd]));

  if (asPostgres) await run('chown', ['-R', 'postgres:postgres', dataDir, runDir]);
  log(`[env] initialising local postgres cluster in ${dataDir}`);
  await shellRun(`${binDir}/initdb -D ${dataDir} -U postgres --auth=trust`);
  await shellRun(
    `${binDir}/pg_ctl -D ${dataDir} -o "-p ${port} -k ${runDir} -c listen_addresses=127.0.0.1" -l ${dataDir}/server.log start`,
  );
  await run('sh', ['-c', `${binDir}/psql -h 127.0.0.1 -p ${port} -U postgres -c "CREATE DATABASE ${database}"`]).catch(
    () => {},
  );
  return {
    url,
    kind: 'local-cluster',
    async stop() {
      await shellRun(`${binDir}/pg_ctl -D ${dataDir} -m immediate stop`).catch(() => {});
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
      await rm(runDir, { recursive: true, force: true }).catch(() => {});
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
    await run('sh', ['-c', `psql "${databaseUrl}" -v ON_ERROR_STOP=1 -f "${file}"`]);
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
  for (let i = 0; i < 120; i += 1) {
    const ok = await fetch(`${base}/api/health`).then((r) => r.status < 500, () => false);
    if (ok) break;
    if (child.exitCode !== null) throw new Error(`next start exited ${child.exitCode}\n${logLines.join('')}`);
    await new Promise((r) => setTimeout(r, 500));
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

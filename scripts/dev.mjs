#!/usr/bin/env node
/**
 * Local development: both Workers in ONE workerd process (Miniflare), sharing wrangler's local D1 data
 * in .wrangler/state (the same files `wrangler d1 ... --local --persist-to .wrangler/state` uses).
 *
 *   public site  http://localhost:8787
 *   dashboard    http://localhost:8788   (mock identity from workers/admin/.dev.vars; localhost only)
 *
 * Why not two `wrangler dev` processes? workerd locks its local SQLite files, so two processes cannot
 * share one local D1 database. Bindings mirror wrangler: config "vars", then .dev.vars overrides.
 * Pending migrations are applied on start (recorded in wrangler's d1_migrations table), the cron
 * reconciliation runs every minute, and code changes rebuild and reload automatically.
 */
import { context } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';

const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? 8787);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 8788);

function stripJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readDevVars(path) {
  if (!existsSync(path)) return {};
  const vars = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    vars[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return vars;
}

for (const worker of ['public', 'admin']) {
  const vars = `workers/${worker}/.dev.vars`;
  if (!existsSync(vars)) {
    copyFileSync(`${vars}.example`, vars);
    console.log(`Created ${vars} from the example. Add your Stripe TEST keys there to take test payments.`);
  }
}

const configs = Object.fromEntries(['public', 'admin'].map((w) => [w, stripJsonc(readFileSync(`workers/${w}/wrangler.jsonc`, 'utf8'))]));
const bindings = (w) => ({ ...configs[w].vars, ...readDevVars(`workers/${w}/.dev.vars`) });
const DB_ID = configs.public.d1_databases[0].database_id;
if (configs.admin.d1_databases[0].database_id !== DB_ID) throw new Error('Both Worker configs must use the same D1 database_id');

let mf = null;
let loadedHash = '';
const bundleHash = () =>
  createHash('sha256')
    .update(['public', 'admin'].map((w) => readFileSync(`.wrangler/dev-build/${w}.js`, 'utf8')).join('\n'))
    .digest('hex');
const options = () => ({
  host: '127.0.0.1',
  port: PUBLIC_PORT,
  d1Persist: '.wrangler/state/v3/d1',
  workers: ['public', 'admin'].map((w) => ({
    name: w,
    modules: true,
    scriptPath: `.wrangler/dev-build/${w}.js`,
    compatibilityDate: configs[w].compatibility_date,
    d1Databases: { DB: DB_ID },
    bindings: bindings(w),
    ...(w === 'admin' ? { unsafeDirectSockets: [{ host: '127.0.0.1', port: ADMIN_PORT }] } : {}),
  })),
});

const build = await context({
  entryPoints: { public: 'src/public/index.ts', admin: 'src/admin/index.ts' },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  conditions: ['workerd', 'worker', 'browser'],
  outdir: '.wrangler/dev-build',
  sourcemap: 'inline',
  logLevel: 'warning',
  plugins: [
    {
      name: 'reload',
      setup(b) {
        b.onEnd(async (result) => {
          if (result.errors.length || !mf) return;
          const hash = bundleHash();
          if (hash === loadedHash) return; // e.g. the initial build esbuild runs when watching starts
          loadedHash = hash;
          await mf.setOptions(options());
          console.log(`[dev] rebuilt and reloaded (${new Date().toLocaleTimeString('en-GB')})`);
        });
      },
    },
  ],
});
await build.rebuild();
loadedHash = bundleHash();
mf = new Miniflare(options());
await mf.ready;

// Apply pending migrations, compatible with `wrangler d1 migrations apply` bookkeeping.
const db = await mf.getD1Database('DB', 'public');
await db.prepare(
  `CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`,
).run();
const applied = new Set((await db.prepare('SELECT name FROM d1_migrations').all()).results.map((r) => r.name));
for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
  if (applied.has(file)) continue;
  const statements = readFileSync(`migrations/${file}`, 'utf8')
    .replace(/--.*$/gm, '')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  await db.batch([...statements.map((s) => db.prepare(s)), db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(file)]);
  console.log(`[dev] applied migration ${file}`);
}
const listings = await db.prepare('SELECT COUNT(*) AS n FROM listings').first();
if (!listings.n) console.log('[dev] The database is empty. Stop this (Ctrl+C) and run `npm run db:seed:local` for fictional sample classes.');

await build.watch();
const cron = setInterval(async () => {
  try {
    const worker = await mf.getWorker('public');
    await worker.scheduled({ cron: '*/10 * * * *' });
  } catch (e) {
    console.log('[dev] scheduled run failed:', e.message);
  }
}, 60_000);

console.log(`\n  Public site:  http://localhost:${PUBLIC_PORT}\n  Dashboard:    http://localhost:${ADMIN_PORT}\n  (Ctrl+C to stop; reconciliation cron runs every minute)\n`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(cron);
  await build.dispose();
  await mf.dispose();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

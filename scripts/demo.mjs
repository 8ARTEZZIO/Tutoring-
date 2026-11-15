#!/usr/bin/env node
// `npm run demo`: bundles the Workers and the demo server, then starts the clickable demo
// (fictional data, stand-in Stripe Checkout, no accounts or keys). See scripts/demo-server.ts.
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const out = '.wrangler/demo-build';
await build({
  entryPoints: { public: 'src/public/index.ts', admin: 'src/admin/index.ts' },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  conditions: ['workerd', 'worker', 'browser'],
  outdir: out,
  logLevel: 'warning',
});
await build({
  entryPoints: ['scripts/demo-server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  outfile: `${out}/demo-server.mjs`,
  logLevel: 'warning',
});
await import(pathToFileURL(`${out}/demo-server.mjs`).href);

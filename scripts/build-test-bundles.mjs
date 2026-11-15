// Bundles both Workers with esbuild for the Miniflare-based test suite (wrangler does its own bundling).
import { build } from 'esbuild';
import { existsSync } from 'node:fs';

const entryPoints = {};
if (existsSync('src/public/index.ts')) entryPoints.public = 'src/public/index.ts';
if (existsSync('src/admin/index.ts')) entryPoints.admin = 'src/admin/index.ts';

await build({
  entryPoints,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  conditions: ['workerd', 'worker', 'browser'],
  outdir: '.test-build',
  sourcemap: 'inline',
  logLevel: 'warning',
});
console.log('built', Object.keys(entryPoints).join(', '));

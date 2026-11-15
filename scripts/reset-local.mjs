#!/usr/bin/env node
// Wipes the LOCAL D1 database, re-applies migrations and re-seeds fictional data.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

rmSync('.wrangler/state/v3/d1', { recursive: true, force: true });
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
execFileSync('npm', ['run', 'db:migrate:local'], { stdio: 'inherit', env });
execFileSync('node', ['scripts/seed-local.mjs'], { stdio: 'inherit', env });

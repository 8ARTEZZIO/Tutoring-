#!/usr/bin/env node
// Verifies that every reachable dashboard hostname refuses unauthenticated requests.
// Usage: npm run check:admin-lockdown -- https://kingston-tutoring-admin.<subdomain>.workers.dev [more hostnames...]
// A pass means: redirected to Cloudflare Access login (302/303 to *.cloudflareaccess.com) or refused (401/403).
const hosts = process.argv.slice(2);
if (hosts.length === 0) {
  console.error('Usage: npm run check:admin-lockdown -- https://<admin-host> [https://<other-host> ...]');
  process.exit(2);
}

const forged =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6ImZvcmdlZCJ9.eyJlbWFpbCI6ImF0dGFja2VyQGV4YW1wbGUuY29tIiwiYXVkIjpbIngiXSwiZXhwIjo0MTAyNDQ0ODAwfQ.c2lnbmF0dXJl';
const probes = [
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/settings' },
  { method: 'GET', path: '/listings/new' },
  { method: 'GET', path: '/assets/admin.js' },
  { method: 'POST', path: '/listings', body: 'title=probe' },
  { method: 'GET', path: '/', headers: { 'Cf-Access-Jwt-Assertion': forged }, label: 'forged JWT' },
  { method: 'POST', path: '/pause', body: 'paused=1', headers: { 'Cf-Access-Jwt-Assertion': forged }, label: 'forged JWT' },
];

let failures = 0;
let unreachable = 0;
for (const host of hosts) {
  const origin = host.replace(/\/+$/, '');
  for (const p of probes) {
    let verdict;
    try {
      const res = await fetch(origin + p.path, {
        method: p.method,
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(p.headers ?? {}) },
        body: p.body,
      });
      const loc = res.headers.get('location') ?? '';
      const toAccess = [301, 302, 303, 307].includes(res.status) && /cloudflareaccess\.com/.test(loc);
      const ok = toAccess || res.status === 401 || res.status === 403;
      verdict = `${ok ? 'PASS' : 'FAIL'}  ${res.status}${toAccess ? ' → Access login' : ''}`;
      if (!ok) failures++;
    } catch (e) {
      unreachable++;
      verdict = `WARN  unreachable (${e.cause?.code ?? e.message})`;
    }
    console.log(`${verdict.padEnd(32)} ${p.method.padEnd(4)} ${origin}${p.path}${p.label ? `  [${p.label}]` : ''}`);
  }
}
if (failures) {
  console.error(`\n${failures} probe(s) reached the dashboard without authentication. Fix Cloudflare Access before using the dashboard.`);
  process.exit(1);
}
if (unreachable) {
  console.error(`\n${unreachable} probe(s) could not connect. Check the hostname(s); an unreachable host proves nothing.`);
  process.exit(1);
}
console.log('\nAll probes refused. The dashboard is locked down on these hostnames.');

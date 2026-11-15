# Kingston Tutoring: booking pilot

Mobile-first booking site for live small-group Python practice, plus a private tutor dashboard.
Two Cloudflare Workers share one D1 database; payments use hosted Stripe Checkout (test mode until you
switch it yourself).

| Part | What it is | Local URL |
|---|---|---|
| Public site (`workers/public`) | Landing page with the booking card, weekly UK-time calendar, class pages, invite links, booking form, Stripe Checkout, private booking pages, ICS, waitlist, signed Stripe webhook, 10-minute reconciliation cron | http://localhost:8787 |
| Tutor dashboard (`workers/admin`) | Behind Cloudflare Access (the Worker also validates the Access JWT itself): listings and dates, publishing, roster CSV, invites, offline payments, payment recheck, refunds, email templates, waitlist, settings, stats, audit log | http://localhost:8788 |
| iPhone app (`ios/`) | Free SwiftUI companion for students who have booked: class times in UK and local time, join links, reminders, Add to Calendar, cancellation requests, offline. It sells nothing (booking and payment stay on the website). See [ios/README.md](ios/README.md) | Xcode Simulator |

Everything is server-rendered HTML with one small stylesheet and a tiny optional script. No framework,
no runtime dependencies.

## Quick start (local)

Requirements: Node 22+.

```bash
npm install
npm run db:migrate:local      # create the local D1 database (.wrangler/state)
npm run db:seed:local         # clearly fictional sample classes, dated relative to today
npm run dev                   # public site :8787 + dashboard :8788 in one local workerd
```

Open http://localhost:8787 (site) and http://localhost:8788 (dashboard). Locally the dashboard uses the
mock identity from `workers/admin/.dev.vars` (`DEV_ADMIN_EMAIL`). It is honoured only when
`ENVIRONMENT=development` **and** the host is `localhost`; the dashboard refuses to start if it is set
anywhere else.

`npm run dev` creates `workers/*/.dev.vars` from the examples on first run. To take test payments locally,
put your Stripe **test** secret key in `workers/public/.dev.vars` and `workers/admin/.dev.vars`, then follow
[Run a real Stripe test payment](docs/DEPLOY.md#6-run-a-real-stripe-test-payment-locally-with-the-stripe-cli).
Without a key, pages work and booking shows "temporarily unavailable" (nothing is reserved or charged).

Reset local data at any time with `npm run db:reset:local` (stop `npm run dev` first).

### Clickable demo (no accounts or keys)

```bash
npm run demo     # site :8787, dashboard :8788, fictional data in memory
```

Runs the real Workers with fictional classes and students, plus a stand-in Stripe Checkout page: press
**Book** there to simulate a successful card payment and the confirmation flow runs exactly as in production
(signed webhook, verification, private booking page). The demo dashboard has an open mock identity, so it is
for local demos only and is never deployed.

## Tests

```bash
npm test                 # typecheck + unit + acceptance tests (both Workers run in workerd via Miniflare)
npm run test:browser     # Playwright phone/keyboard checks + screenshots in docs/screenshots/
```

The acceptance tests run the real bundled Workers against one D1 database, with outbound calls routed to a
stateful Stripe emulator (`test/helpers/fake-stripe.ts`). The emulator reproduces the behaviours the design
relies on: idempotency keys (replays return the saved response, including saved 5xx), concurrent-key 409s,
the 30-minute-to-24-hour `expires_at` rule, expiry, refunds, and v1 webhook signatures. It can also drop
responses after creating a session, to simulate a lost response.

`npm run test:browser` needs Playwright and Chromium: `npm i --no-save playwright && npx playwright install chromium`.

| Acceptance test (build plan §8) | Where | Result |
|---|---|---|
| General visit, invite, expired invite and already paid | `test/acceptance/entry-routes.test.ts`, browser entry-route check | Pass |
| Four-date package: one payment, one seat on all dates, ICS with four events | `test/acceptance/package.test.ts` | Pass |
| Simultaneous requests for the last seat | `test/acceptance/last-seat.test.ts` | Pass |
| Double-click, webhook retries and late payment return | `test/acceptance/idempotency.test.ts` | Pass |
| Lost Stripe response, expired checkout, full and partial refund, cancelled group | `test/acceptance/recovery.test.ts` | Pass |
| Fake return URL, mismatched amount, invalid signature, unauthorised admin user | `test/acceptance/security.test.ts` | Pass |
| GMT/BST boundary and a rescheduled date | `test/acceptance/timezones.test.ts` | Pass |
| Phone, keyboard, full group and no upcoming dates | `test/browser/phone.test.ts` (Chromium) | Pass |
| Operator rehearsal: publish rules, clashes, offline payment, waitlist, pause, requests, terms versions, rate limits | `test/acceptance/operator.test.ts` | Pass |
| iPhone app API: links, refresh, revoke, cancellation requests, malformed input, rate limits, App Review demo, universal links, app view of policy pages | `test/acceptance/app-api.test.ts` | Pass |
| iPhone app logic: links, API client, offline, in-flight changes, reminders, time zones, demo server (47 tests) | `ios/KingstonTutoringCore` (`cd ios && ./setup.sh test`) | Pass |

What the automated tests do **not** cover, and you must do once with your own accounts: a real Stripe
test-mode payment through Stripe's hosted page with the Stripe CLI forwarding webhooks, Cloudflare Access on
the deployed dashboard hostname, and a nine-person call on your video service (see
[docs/DEPLOY.md](docs/DEPLOY.md)).

## How bookings stay correct

- **One seat, atomically.** A single conditional `INSERT … SELECT` re-checks published status, cutoff,
  pause switch, capacity (holds + confirmed + exceptions) and duplicate email, backed by a partial unique
  index. Simultaneous requests for the last seat produce exactly one payable Checkout.
- **Idempotent Checkout.** The exact Stripe request body is saved before it is sent and replayed
  byte-for-byte with the same `Idempotency-Key`. The Checkout expiry is fixed at reservation + 40 minutes,
  so a late replay can never create a session that is still payable after the hold should have ended.
- **Verified state only.** Webhooks, the browser return, the cron and the dashboard "Recheck" all re-fetch
  the session from Stripe and go through one fulfilment function. A seat is released only when Stripe
  says the session expired unpaid, or a request definitely failed. Unknown outcomes keep the seat held and
  appear under "Needs attention".
- **Private by default.** Booking links and invites are 256-bit tokens stored only as SHA-256 hashes. A
  link is exchanged for an HttpOnly cookie and removed from the URL. Private pages are `no-store`,
  `noindex`, and never send a Referer to other sites. The public booking id alone opens nothing.

## Documentation

- [docs/DEPLOY.md](docs/DEPLOY.md): settings you must supply, exact deploy commands, Cloudflare Access,
  Turnstile, Stripe webhooks, the real Stripe test payment, going live, and costs and quotas.
- [docs/RUNBOOK.md](docs/RUNBOOK.md): day-to-day operation: publish a group, share links, run a class from the
  roster, change dates, cancel, refund, reconcile a payment, recover a private link, pause bookings, data
  requests and check costs.
- [ios/README.md](ios/README.md): build and run the iPhone app, and
  [ios/AppStore/submission-checklist.md](ios/AppStore/submission-checklist.md) to publish it (listing text,
  review notes, privacy answers, screenshots).

## Layout

```
src/shared/     booking engine, Stripe client, D1 queries, UK time, ICS, CSV, settings, UI components
src/public/     public Worker (routes + pages + webhook + cron)
src/admin/      dashboard Worker (Access JWT auth, CSRF, pages)
migrations/     D1 schema (applied with wrangler)
workers/*/      wrangler.jsonc per Worker, .dev.vars / .secrets examples
scripts/        dev runner, local seed/reset, admin lockdown check, test bundler, app icon renderer
test/           unit, acceptance (Miniflare) and browser (Playwright) tests
ios/            iPhone app: Xcode project, SwiftUI screens, tested Swift core package, App Store kit
```

# Deploying the pilot

This guide takes you from an empty Cloudflare account to two live `workers.dev` URLs taking **Stripe test
mode** payments. Live payments stay off until you deliberately follow [Going live](#9-going-live-your-decision).

## 1. Settings you must supply

| Setting | Where it goes | Notes |
|---|---|---|
| D1 `database_id` | both `workers/*/wrangler.jsonc` | from `npx wrangler d1 create` (same id in both files) |
| `PUBLIC_ORIGIN`, `ADMIN_ORIGIN` | `vars` in both configs | your two `https://….workers.dev` URLs |
| `APP_SECRET` | secret, **each** Worker (different values) | 32+ random characters; signs cookies/CSRF and hashes IPs |
| `STRIPE_SECRET_KEY` | secret, both Workers | `sk_test_…` (or a restricted `rk_test_…` key, see §5) |
| `STRIPE_WEBHOOK_SECRET` | secret, public Worker | `whsec_…` from the webhook endpoint in §5 |
| `STRIPE_MODE` | `vars` in both configs | keep `"test"` until you go live |
| `TURNSTILE_SITE_KEY` | `vars`, public config | from Cloudflare Turnstile (§4) |
| `TURNSTILE_SECRET_KEY` | secret, public Worker | public forms are refused in production until set |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | `vars`, admin config | from Cloudflare Zero Trust (§3) |
| `ADMIN_EMAILS` | secret, admin Worker | your login email (comma-separated if more than one) |
| Seller name, geographic address, contact email | dashboard → Settings | shown before payment; publishing is blocked in production until set |
| Terms, cancellation, early-start and privacy wording | dashboard → Settings | the defaults are a starting draft for you to review, not legal advice |
| Real dates and call links | dashboard → listing | publishing is blocked for placeholder links (`example.com`, `.test`, …) |

Optional: `APPLE_APP_IDS` (`vars`, public config: `"<TEAM ID>.<bundle id>"` once you publish the iPhone app,
so private links open it; see §10), `BOOKINGS_PAUSED=true` (emergency pause), `STRIPE_ENV_TAG` (if two deployments share one Stripe
account), `STRIPE_API_VERSION` (defaults to `2025-03-31.basil`).

Anything other than `ENVIRONMENT=development|test` is treated as production. Production fails closed: no
mock identity, no API overrides, `https` origins required, Turnstile required on public forms.

## 2. Create the database and deploy

```bash
npm install
npx wrangler login
npx wrangler d1 create kingston-tutoring
# Paste the printed database_id into BOTH workers/public/wrangler.jsonc and workers/admin/wrangler.jsonc.
# Set PUBLIC_ORIGIN / ADMIN_ORIGIN in both files to
#   https://kingston-tutoring.<your-subdomain>.workers.dev
#   https://kingston-tutoring-admin.<your-subdomain>.workers.dev
# (your workers.dev subdomain is shown in the dashboard under Workers & Pages).

npm run db:migrate:remote
```

The configs declare required secrets, so wrangler refuses the **first** deploy of each Worker unless the
secrets come with it. Create the secrets files from the examples (they are git-ignored), fill them in,
deploy, then delete them:

```bash
cp workers/public/.secrets.example workers/public/.secrets   # edit values
cp workers/admin/.secrets.example  workers/admin/.secrets    # edit values
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # run twice: one APP_SECRET per Worker

npx wrangler deploy -c workers/public/wrangler.jsonc --secrets-file workers/public/.secrets
npx wrangler deploy -c workers/admin/wrangler.jsonc  --secrets-file workers/admin/.secrets
rm workers/public/.secrets workers/admin/.secrets
```

After that, everyday deploys are `npm run deploy` (remote migrations, then both Workers). To change one
secret: `npx wrangler secret put STRIPE_SECRET_KEY -c workers/public/wrangler.jsonc`.

Don't run the fixtures against production: `npm run db:seed:local` only ever writes to the local database.

Both configs set `preview_urls: false` (no `<version>-<name>.workers.dev` preview hosts) and disable
per-request invocation logs, because request paths can contain booking or invite tokens. The app's own
structured logs contain no tokens or emails.

## 3. Lock down the dashboard with Cloudflare Access

1. Cloudflare dashboard → **Zero Trust** (the Free plan covers up to 50 users). Choose a team name; your team
   domain is `https://<team>.cloudflareaccess.com`.
2. **Workers & Pages → kingston-tutoring-admin → Settings → Domains & Routes → workers.dev → Enable
   Cloudflare Access.** This creates an Access application for that hostname. (Alternative: Zero Trust →
   Access → Applications → Add → Self-hosted, hostname `kingston-tutoring-admin.<subdomain>.workers.dev`.)
3. Edit that application's policy: **Allow**, Include → **Emails** → only your address. Remove any broader
   rule.
4. Copy the application's **Audience (AUD) tag**. Put it and your team domain into
   `workers/admin/wrangler.jsonc`:
   ```jsonc
   "ACCESS_TEAM_DOMAIN": "https://<team>.cloudflareaccess.com",
   "ACCESS_AUD": "<aud tag>"
   ```
   Then run `npm run deploy:admin`.
5. Verify every reachable admin hostname refuses unauthenticated requests:
   ```bash
   npm run check:admin-lockdown -- https://kingston-tutoring-admin.<subdomain>.workers.dev
   ```
   Every line must say PASS (redirect to the Access login, or 401/403). The Worker itself also rejects any
   request without a valid Access JWT for your AUD, issuer and email, so a mistake in the Access policy
   still doesn't open the dashboard.
6. Log in once in a browser to confirm you reach the Overview.

## 4. Turnstile (spam protection on public forms)

Cloudflare dashboard → **Turnstile → Add widget**, hostname `kingston-tutoring.<subdomain>.workers.dev`,
mode Managed. Put the site key in `TURNSTILE_SITE_KEY` (public config `vars`) and the secret with
`npx wrangler secret put TURNSTILE_SECRET_KEY -c workers/public/wrangler.jsonc`. Deploy.

## 5. Stripe (test mode)

1. Stripe Dashboard → turn **Test mode** on → Developers → API keys → copy the secret key (`sk_test_…`).
   Optional hardening: create a **restricted key** with Checkout Sessions *Write*, PaymentIntents *Read*,
   Refunds *Read* and use that (`rk_test_…`).
2. Developers → **Webhooks → Add endpoint**:
   - URL: `https://kingston-tutoring.<subdomain>.workers.dev/webhooks/stripe`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`,
     `refund.created`, `refund.updated`, `refund.failed`, `charge.dispute.created`
   - Copy the **signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` (public Worker).
3. Optional: Settings → Customer emails → enable successful-payment receipts.

Every Checkout Session carries `metadata[booking_id]`, `metadata[env]` and a fixed `expires_at`
(reservation + 40 minutes). Payments are verified by re-fetching the session from Stripe; event bodies are
treated as hints only.

## 6. Run a real Stripe test payment locally with the Stripe CLI

```bash
# workers/public/.dev.vars and workers/admin/.dev.vars: STRIPE_SECRET_KEY=sk_test_...
stripe login
stripe listen --forward-to localhost:8787/webhooks/stripe \
  --events checkout.session.completed,checkout.session.expired,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,charge.refunded,refund.created,refund.updated
# copy the printed whsec_... into workers/public/.dev.vars as STRIPE_WEBHOOK_SECRET, then in another terminal:
npm run dev
```

1. Open http://localhost:8787 → **Book a seat** → enter a name and your email → Continue to payment.
2. On Stripe's page pay with `4242 4242 4242 4242`, any future expiry, any CVC and postcode.
3. You return to a "You're booked!" page with the call link. The `stripe listen` window shows
   `checkout.session.completed` → `200`.
4. In the dashboard (http://localhost:8788), the booking is Confirmed. Press **Recheck payment with Stripe**
   to see the verified state.
5. Refund test: `stripe refunds create --payment-intent pi_…` (the id is on the booking page in the
   dashboard). The webhook marks it fully refunded; **Verify refund in Stripe and release seat** frees the
   seat.
6. Expiry test: start a booking and abandon the Stripe page. After 40 minutes Stripe expires it and the
   seat is released (or press **Release my seat** on the cancel page to do it straight away).

Repeat steps 1–4 once against the deployed site (with the §5 webhook) before sharing any link.

## 7. Video calls

Paste a meeting link per date in the dashboard (shown only to confirmed students). Test a call with nine
participants (8 students + you) for the full class length. Free Google Meet group calls end at 60 minutes,
which leaves no margin for a 60-minute class, so use a plan or service without that limit if needed.

## 8. Costs and quotas (pilot target: £0/month fixed)

| Service | Free allowance (check the linked pricing pages) | What happens at the limit |
|---|---|---|
| Workers Free | 100,000 requests/day, 10 ms CPU per request, cron triggers | Requests fail with a Cloudflare error until 00:00 UTC. Stripe retries webhooks for up to 3 days and the cron catches up, so paid bookings are still confirmed afterwards. Heavy CPU use would show error 1102; Workers Paid is $5/month. |
| D1 Free | 5 GB storage, 5M rows read/day, 100k rows written/day | Queries fail and pages show "Something went wrong" until the daily reset. Each page view reads a few dozen rows; each booking writes a handful. |
| Access Free | up to 50 users | n/a for one operator |
| Turnstile Free | free | n/a |
| Stripe UK | 1.5% + 20p per standard UK card | £15 → about £0.43; £80 → £1.40; £108 → £1.82. Other cards cost more. |

Usage: Cloudflare dashboard → Workers & Pages (requests, CPU), Storage & Databases → D1 (rows
read/written), Billing → Billable usage. Stripe → Payments and Balance for fees.

Links: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[Access](https://www.cloudflare.com/en-gb/sase/products/access/),
[Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/),
[Turnstile](https://developers.cloudflare.com/turnstile/plans/),
[Stripe UK pricing](https://stripe.com/gb/pricing).

Later options (not built): automated confirmation emails from a verified sending domain (for example
Resend), a custom domain, SMS, student accounts.

## 9. Going live (your decision)

The app refuses a live key unless `STRIPE_MODE` is `"live"`, refuses `"live"` with a test key, and refuses
live keys outside production. To switch:

1. Finish Stripe account activation (business details, bank account) and review Settings wording and seller
   details in the dashboard.
2. Keep test and live data apart. Recommended: `npx wrangler d1 create kingston-tutoring-live`, put the new
   id in both configs, `npm run db:migrate:remote`, then re-enter Settings and listings.
3. In Stripe **live** mode create the same webhook endpoint (§5) and copy its live `whsec_…`.
4. `npx wrangler secret put STRIPE_SECRET_KEY` (live key) for both Workers and `STRIPE_WEBHOOK_SECRET` for the
   public Worker. Set `"STRIPE_MODE": "live"` in both configs and `npm run deploy`.
5. Make one real low-value booking, check it end to end, then refund it from the Stripe Dashboard.

## 10. The iPhone app (optional)

The free companion app in `ios/` talks to the public Worker's `/api/app/v1/*` endpoints, which are deployed
with it; there is nothing extra to switch on. To let private links open the app, set
`"APPLE_APP_IDS": "<TEAM ID>.<bundle id>"` in `workers/public/wrangler.jsonc` (the same values as
`ios/Config.xcconfig`) and `npm run deploy:public`. The site then serves
`/.well-known/apple-app-site-association` for `/b/*` links. Building, testing and App Store submission are
in [ios/README.md](../ios/README.md).

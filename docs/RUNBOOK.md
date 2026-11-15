# Operator runbook

Everything below happens in the dashboard (`https://kingston-tutoring-admin.<subdomain>.workers.dev`, or
http://localhost:8788 locally) unless it says Stripe Dashboard. Times you enter are **UK time**; the app
stores UTC and shows GMT/BST labels everywhere.

## Publish a group

1. **New listing** → title, type (single class or package), total price per student, seats, booking cutoff
   (minimum 45 minutes before the first date so Checkout can finish), description. It starts as a draft.
2. **Add a date** for each session with its private call link. On a clock-change night the form refuses a
   time that doesn't exist (spring) and asks which one you mean when a time happens twice (autumn).
3. Fix anything in the yellow box: missing links, placeholder links, seller details, clashes with another
   published group, a first date too soon.
4. **Preview**, then **Publish**. It appears on the home page, calendar and `/session/<link-name>`.

**Close bookings** stops new bookings but keeps the group and its students. **Reopen** re-checks the
publish rules.

## Share it

- **Share link (per channel)**: a reusable `/i/<code>` for WhatsApp, Instagram, a QR poster and so on. The
  Stats page counts visits, checkout starts and paid bookings per code (aggregate only, no cookies or
  personal data). The Overview also has a general share link that opens whichever group is next.
- **Individual invitation**: an expiring link for one person. It is shown once (only a hash is stored), so
  copy it straight away. The listing shows its status (not opened, opened, checkout started, confirmed) and
  you can revoke it.
- A plain `/?ref=<code>` link on a poster is also counted.

## Run a class

Open the listing → **Roster** (confirmed students) → **Download roster (CSV)**. The dates table shows each
call link. **Reminder (BCC)** prepares a reminder email; **Open in mail app** or **Open in Gmail** opens it
in your own mailbox. After sending, press **I've sent it: mark as sent**. Nothing is ever emailed
automatically.

## Confirmations and private links

A student who pays sees their booking straight away on the same device, and can create a private link for
another device. To send the confirmation email: booking → **Prepare confirmation email (new private
link)**. This creates a fresh link inside the email; older links keep working until you **Revoke all private
links**.

**Recover a lost private link**: students can ask at "Lost your booking link?". Requests appear under
**Private link requests** on the Overview. **Handle** → **Issue new link & prepare email** → send → done.
The page never reveals whether an email has a booking.

## Change a date or call link

Listing → **Edit** on the date. If anyone holds a seat, the change is recorded, the calendar event's
sequence number goes up (calendar apps update the same event), and **Schedule changes not yet sent** lists
the affected students. Press **Prepare date-change email**, send it (BCC), then **mark as sent**. Students'
booking pages always show the current schedule and an updated `.ics` download.

## Cancellations and refunds

- **Student asks to cancel**: they use **Request cancellation** on their booking page; it appears under
  **Cancellation requests**. Decide what's due under your terms. Refund in the **Stripe Dashboard**
  (Payments → the payment → Refund). The refund syncs back by webhook (or press **Sync refunds from
  Stripe**). Then **Cancel seat** if they're leaving, and **Mark request handled**.
- **Full refund**: the booking shows "Fully refunded". **Verify refund in Stripe and release seat**
  re-checks Stripe before freeing the seat.
- **Partial refund** (for example after session 1 of 4): the seat stays booked; cancelling the seat is a
  separate action.
- **Cancel a whole group**: listing → **Cancel group** (with an optional reason). New checkouts stop
  immediately, open Stripe Checkouts are expired, payments already in flight are reconciled, and the page
  lists everyone who paid and still needs a refund. Then **Prepare cancellation email** (BCC to everyone booked).

## Reconcile a payment

States you may see:

| State | Meaning | Action |
|---|---|---|
| Held · creating checkout | Seat claimed; Stripe's answer was lost or uncertain | Seat stays held. **Recheck payment with Stripe** replays the exact request safely. |
| Checkout open | Student can pay until the fixed 40-minute expiry | Nothing. The seat is released only after Stripe says it expired unpaid. |
| Needs review | Payment doesn't match the booking, or arrived after release | Check it in Stripe, then **Accept payment and confirm seat**, or cancel and refund. |
| Confirmed / Cancelled | Final | n/a |

The cron reconciles stale checkouts every 10 minutes. **Reconcile payments with Stripe now** on the
Overview runs it on demand. Each booking page has a Stripe recovery procedure and links to the session and
payment in the Stripe Dashboard. **Payment issues** lists webhook events that didn't process. Stripe
retries those automatically.

## Pause bookings

Overview → **Pause all new bookings**: takes effect immediately for new checkouts (enforced inside the seat
claim). Students already on Stripe's page can still pay, and those payments are confirmed. **Resume
bookings** undoes it. Emergency switch without the dashboard: `npx wrangler secret put BOOKINGS_PAUSED -c
workers/public/wrangler.jsonc` with value `true`; resume with `npx wrangler secret delete BOOKINGS_PAUSED -c workers/public/wrangler.jsonc`.

## Waitlist

Students join from full groups (seat alert, checked by default) and can also opt in to a weekly practice
question (unchecked by default). Listing → **Seat opening alert (BCC waitlist)** prepares an email with the
booking link for this group plus "any date" sign-ups. Mark it sent to stamp the entries. **Waitlist** shows
everyone, including a copyable BCC list of weekly-question opt-ins, per-entry delete, and **Remove stale
leads…** which applies the retention plan (deletes old leads, anonymises old unpaid attempts, keeps paid
bookings for accounting).

## The iPhone app

Students can add their booking to the free iPhone app (see [ios/README.md](../ios/README.md)) by opening
their private link on an iPhone or pasting it into the app. Nothing changes for you: the app shows the same
dates, links and status as the private booking page, and picks up date changes when the student opens it.
Cancellation requests from the app arrive like the ones from the website. **Revoke all private links** on a
booking also signs every app out of it. Keep the hidden `App Review demo` listing (see
[ios/AppStore/review-notes.md](../ios/AppStore/review-notes.md)) for future app updates.

## Data requests

Students can ask to see or delete their data (by email, or from the app's **Ask for your data to be
deleted**). Reply within one month. Find their entries in the roster of each group they booked (or search
the roster CSV export), on **Waitlist** and under **Private link requests**, then:

- **Delete**: remove their waitlist and interest entries (per-entry delete), and on each booking use
  **Revoke all private links**, which also signs any iPhone app out. Paid booking records are kept for tax and
  accounting, as the privacy notice says (normally six years); say so in your reply.
- **Access**: send them what the dashboard holds about them (booking details, dates, payments, requests).

## Wording and settings

Settings holds seller details, terms, cancellation summary, early-start wording, privacy notice, retention
days, FAQ text and every email template. Changing agreed wording creates a new version, and each booking
records the terms version (and early-start wording version) the student accepted.

## Check costs

Cloudflare dashboard → Workers & Pages (requests/CPU per Worker), D1 → metrics (rows read/written),
Billing → Billable usage. Stripe → Balance → fees. See [DEPLOY.md §8](DEPLOY.md#8-costs-and-quotas-pilot-target-0month-fixed)
for limits and what happens when one is reached.

## Audit trail

**Audit log** records every operator action (who, what, when) and notable system events (payment confirmed,
payment exceptions, refunds released, roster exports).

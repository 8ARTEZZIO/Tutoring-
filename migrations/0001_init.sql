-- Kingston Tutoring pilot schema.
-- All timestamps are INTEGER unix seconds in UTC. Display conversion to Europe/London happens in the app.

-- A bookable offer: a single class or a fixed-date package. One booking = one seat on every lesson.
CREATE TABLE listings (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('single', 'package')),
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  price_pence INTEGER NOT NULL CHECK (price_pence >= 0),
  currency TEXT NOT NULL DEFAULT 'gbp',
  capacity INTEGER NOT NULL CHECK (capacity > 0 AND capacity <= 50),
  cutoff_minutes INTEGER NOT NULL DEFAULT 120 CHECK (cutoff_minutes >= 45),
  format TEXT NOT NULL DEFAULT 'Online',
  tutor TEXT NOT NULL DEFAULT 'bartek',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'cancelled')),
  -- Denormalised from lessons by the app whenever lessons change.
  first_starts_at INTEGER,
  last_ends_at INTEGER,
  bookings_close_at INTEGER,
  lesson_count INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT,
  published_at INTEGER,
  closed_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX listings_status_start ON listings (status, first_starts_at);

-- Individual dates of a listing. meeting_url is private (only shown to confirmed students).
CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings (id),
  seq INTEGER NOT NULL DEFAULT 0,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  meeting_url TEXT,
  uid TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX lessons_listing_start ON lessons (listing_id, starts_at);
CREATE INDEX lessons_start ON lessons (starts_at);

-- History of date/link changes to lessons, used for the affected-student list and update emails.
CREATE TABLE lesson_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id TEXT NOT NULL REFERENCES lessons (id),
  listing_id TEXT NOT NULL REFERENCES listings (id),
  change_kind TEXT NOT NULL,
  old_starts_at INTEGER,
  old_ends_at INTEGER,
  new_starts_at INTEGER,
  new_ends_at INTEGER,
  changed_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  notified_at INTEGER
);
CREATE INDEX lesson_changes_listing ON lesson_changes (listing_id, changed_at);

-- Outreach links. 'share' links are reusable public codes (stored in plain text so the operator can copy
-- them again). 'individual' invites are bearer tokens: only the SHA-256 hash is stored.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('share', 'individual')),
  listing_id TEXT REFERENCES listings (id),
  code TEXT UNIQUE,
  token_hash TEXT UNIQUE,
  channel TEXT NOT NULL DEFAULT 'direct',
  note TEXT,
  expires_at INTEGER,
  revoked_at INTEGER,
  first_opened_at INTEGER,
  last_opened_at INTEGER,
  open_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  CHECK ((kind = 'share' AND code IS NOT NULL) OR (kind = 'individual' AND token_hash IS NOT NULL))
);
CREATE INDEX invites_listing ON invites (listing_id);

-- One row per seat claim. Occupied seats = status IN ('hold','pending','confirmed','exception').
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings (id),
  email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'invite', 'manual')),
  source_code TEXT NOT NULL DEFAULT 'direct',
  invite_id TEXT REFERENCES invites (id),
  status TEXT NOT NULL CHECK (status IN ('hold', 'pending', 'confirmed', 'exception', 'expired', 'failed', 'cancelled')),
  price_pence INTEGER NOT NULL,
  currency TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  early_start_requested INTEGER NOT NULL DEFAULT 0,
  early_start_ack INTEGER NOT NULL DEFAULT 0,
  early_start_text_version TEXT,
  request_nonce_hash TEXT,
  checkout_attempt_id TEXT UNIQUE,
  checkout_request TEXT,
  checkout_requested_at INTEGER,
  checkout_expires_at INTEGER,
  checkout_session_id TEXT UNIQUE,
  checkout_url TEXT,
  checkout_attempts INTEGER NOT NULL DEFAULT 0,
  last_checkout_error TEXT,
  payment_intent_id TEXT UNIQUE,
  amount_paid_pence INTEGER,
  stripe_livemode INTEGER,
  payment_reference TEXT,
  refunded_pence INTEGER NOT NULL DEFAULT 0,
  refund_pending_pence INTEGER NOT NULL DEFAULT 0,
  refund_state TEXT NOT NULL DEFAULT 'none' CHECK (refund_state IN ('none', 'pending', 'partial', 'full')),
  refunds_checked_at INTEGER,
  exception_reason TEXT,
  issue TEXT,
  cancel_requested_at INTEGER,
  cancel_request_note TEXT,
  cancel_request_handled_at INTEGER,
  confirmed_at INTEGER,
  cancelled_at INTEGER,
  cancel_reason TEXT,
  released_at INTEGER,
  last_reconciled_at INTEGER,
  redacted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- One active seat per email per listing, enforced by the database even under concurrency.
CREATE UNIQUE INDEX bookings_active_email ON bookings (listing_id, email)
  WHERE status IN ('hold', 'pending', 'confirmed', 'exception');
CREATE INDEX bookings_listing_status ON bookings (listing_id, status);
CREATE INDEX bookings_status_updated ON bookings (status, updated_at);
CREATE INDEX bookings_invite ON bookings (invite_id);
CREATE INDEX bookings_email ON bookings (email);

-- Booking capabilities: device cookies and revocable private links. Only SHA-256 hashes are stored.
CREATE TABLE access_tokens (
  token_hash TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings (id),
  kind TEXT NOT NULL CHECK (kind IN ('device', 'link')),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX access_tokens_booking ON access_tokens (booking_id);

-- Refunds as reported by Stripe (synced, never inferred).
CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings (id),
  amount_pence INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  stripe_created_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);
CREATE INDEX refunds_booking ON refunds (booking_id);

-- Processed webhook events (idempotency + operator visibility).
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  booking_id TEXT,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  outcome TEXT,
  attempts INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX stripe_events_booking ON stripe_events (booking_id);

-- Waitlist / interest. listing_key is a listing id or 'any'. Seat alerts and the weekly practice question
-- (promotional, opt-in, unchecked by default) are separate choices.
CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  listing_key TEXT NOT NULL,
  email TEXT NOT NULL,
  first_name TEXT,
  preferred_days TEXT,
  wants_seat_alert INTEGER NOT NULL DEFAULT 1,
  wants_weekly_question INTEGER NOT NULL DEFAULT 0,
  leave_token_hash TEXT UNIQUE,
  source_code TEXT NOT NULL DEFAULT 'direct',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  left_at INTEGER,
  alert_sent_at INTEGER,
  UNIQUE (listing_key, email)
);

-- "Send me my private link" requests from students on another device; handled by the operator.
CREATE TABLE link_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  handled_at INTEGER,
  handled_by TEXT
);

-- Messages the operator marked as sent from their own mailbox.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  listing_id TEXT,
  booking_id TEXT,
  recipients INTEGER NOT NULL,
  subject TEXT,
  marked_sent_at INTEGER NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX messages_listing ON messages (listing_id);
CREATE INDEX messages_booking ON messages (booking_id);

-- Audit trail of operator actions and notable system events.
CREATE TABLE admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT
);
CREATE INDEX admin_actions_entity ON admin_actions (entity_type, entity_id);
CREATE INDEX admin_actions_at ON admin_actions (at);

-- Editable configuration (seller details, wording, templates). Defaults live in code.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

-- Every published version of terms / privacy / cancellation wording, so bookings can cite a version.
CREATE TABLE policy_versions (
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (kind, version)
);

-- Aggregate first-party counts (no personal data, no tokens).
CREATE TABLE daily_counts (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  code TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, code)
);

-- Fixed-window rate limiting for public forms. Keys are HMACs of the client IP, never raw IPs.
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  win INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, win)
);

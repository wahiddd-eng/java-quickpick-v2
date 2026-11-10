-- Java QuickPick V2 schema. Separate database from V1 (default: java_quickpick_v2 / .data/pglite-v2).
-- All money columns are BIGINT paise (never floating point). Order status and payment status are separate columns.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  phone         text,
  role          text NOT NULL CHECK (role IN ('STUDENT','VENDOR','ADMIN','SUPER_ADMIN')),
  password_hash text,
  sms_consent   boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Student sign-in codes (not the pickup OTP; see pickup_otps).
CREATE TABLE auth_otps (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  code_hash  text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  consumed   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_otps_email_idx ON auth_otps (email, created_at DESC);

-- The business that is paid for food (payout beneficiary). One vendor can own one or more shops.
CREATE TABLE vendors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name          text NOT NULL,
  contact_name        text NOT NULL DEFAULT '',
  contact_phone       text,
  contact_email       text,
  payout_status       text NOT NULL DEFAULT 'NOT_STARTED' CHECK (payout_status IN ('NOT_STARTED','PENDING_KYC','ACTIVE','SUSPENDED')),
  provider_vendor_ref text UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shops (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id              uuid REFERENCES vendors(id) ON DELETE SET NULL,
  code                   text NOT NULL UNIQUE,              -- short human code printed on the counter, e.g. JG01
  qr_token               text NOT NULL UNIQUE,              -- unguessable token encoded in the shop's QR URL
  qr_version             integer NOT NULL DEFAULT 1,
  name                   text NOT NULL,
  description            text NOT NULL DEFAULT '',
  logo_url               text,
  cuisine_tags           text NOT NULL DEFAULT '',          -- comma-separated food categories shown in discovery
  status                 text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','SUSPENDED')),
  accepting_orders       boolean NOT NULL DEFAULT true,
  preorder_enabled       boolean NOT NULL DEFAULT true,
  walkin_enabled         boolean NOT NULL DEFAULT true,
  open_time              text NOT NULL DEFAULT '11:30',     -- HH:MM, Asia/Kolkata
  close_time             text NOT NULL DEFAULT '15:00',
  slot_minutes           integer NOT NULL DEFAULT 10 CHECK (slot_minutes BETWEEN 5 AND 60),
  slot_capacity          integer NOT NULL DEFAULT 5 CHECK (slot_capacity >= 0),
  avg_prep_minutes       integer NOT NULL DEFAULT 10 CHECK (avg_prep_minutes BETWEEN 1 AND 120),
  kitchen_parallel       integer NOT NULL DEFAULT 2 CHECK (kitchen_parallel BETWEEN 1 AND 20),
  accept_timeout_seconds integer NOT NULL DEFAULT 90 CHECK (accept_timeout_seconds BETWEEN 10 AND 900),
  fssai_number           text,
  owner_contact          text,
  is_demo                boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Staff logins for a shop (vendor tablet users).
CREATE TABLE shop_members (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  role    text NOT NULL DEFAULT 'OWNER' CHECK (role IN ('OWNER','MANAGER','STAFF')),
  status  text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  PRIMARY KEY (user_id, shop_id)
);

CREATE TABLE menu_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true
);
CREATE INDEX menu_categories_shop_idx ON menu_categories (shop_id);

CREATE TABLE menu_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  category_id      uuid REFERENCES menu_categories(id) ON DELETE SET NULL,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  base_price_paise bigint NOT NULL CHECK (base_price_paise >= 0),
  diet             text CHECK (diet IN ('VEG','NON_VEG','EGG')),   -- NULL when the vendor has not said
  available        boolean NOT NULL DEFAULT true,
  image_url        text,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX menu_items_shop_idx ON menu_items (shop_id);

-- Add-ons and customisation choices. Rows sharing (menu_item_id, group_name) form one group.
CREATE TABLE menu_item_modifiers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_name   text NOT NULL,
  name         text NOT NULL,
  price_paise  bigint NOT NULL DEFAULT 0 CHECK (price_paise >= 0),
  selection    text NOT NULL DEFAULT 'MANY' CHECK (selection IN ('ONE','MANY')),
  required     boolean NOT NULL DEFAULT false,
  available    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0
);
CREATE INDEX menu_item_modifiers_item_idx ON menu_item_modifiers (menu_item_id);

CREATE TABLE pickup_slots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  capacity       integer NOT NULL CHECK (capacity >= 0),
  reserved_count integer NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  UNIQUE (shop_id, starts_at)
);

-- Fee policy, versioned separately for each ordering mode.
CREATE TABLE pricing_policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_source   text NOT NULL CHECK (order_source IN ('PREORDER','WALKIN_QR')),
  version        integer NOT NULL,
  fee_rate_bps   integer NOT NULL CHECK (fee_rate_bps BETWEEN 0 AND 5000),
  tax_mode       text NOT NULL DEFAULT 'NONE' CHECK (tax_mode IN ('NONE','INCLUSIVE','EXCLUSIVE')),
  tax_rate_bps   integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  approved       boolean NOT NULL DEFAULT false,  -- true only after written CA sign-off
  effective_from timestamptz NOT NULL DEFAULT now(),
  note           text NOT NULL DEFAULT '',
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_source, version)
);

CREATE TABLE orders (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number           text NOT NULL UNIQUE,
  order_source           text NOT NULL CHECK (order_source IN ('PREORDER','WALKIN_QR')),
  user_id                uuid NOT NULL REFERENCES users(id),
  shop_id                uuid NOT NULL REFERENCES shops(id),
  slot_id                uuid REFERENCES pickup_slots(id),
  slot_released          boolean NOT NULL DEFAULT false,
  status                 text NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (status IN
    ('PENDING_PAYMENT','AWAITING_VENDOR','ACCEPTED','PREPARING','READY','COLLECTED','REJECTED','CANCELLED','EXPIRED','NOT_COLLECTED')),
  payment_status         text NOT NULL DEFAULT 'NOT_STARTED' CHECK (payment_status IN
    ('NOT_STARTED','INITIATED','PENDING','SUCCEEDED','FAILED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED','REFUND_FAILED','DISPUTED')),
  subtotal_paise         bigint NOT NULL CHECK (subtotal_paise >= 0),
  fee_rate_bps           integer NOT NULL CHECK (fee_rate_bps >= 0),
  fee_paise              bigint NOT NULL CHECK (fee_paise >= 0),
  tax_mode               text NOT NULL DEFAULT 'NONE',
  tax_rate_bps           integer NOT NULL DEFAULT 0,
  tax_paise              bigint NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  total_paise            bigint NOT NULL CHECK (total_paise >= 0),
  currency               text NOT NULL DEFAULT 'INR',
  pricing_policy_id      uuid NOT NULL REFERENCES pricing_policies(id),
  pricing_policy_version integer NOT NULL,
  idempotency_key        text,
  prep_minutes           integer,
  estimated_ready_at     timestamptz,
  accept_deadline        timestamptz,
  expires_at             timestamptz,
  accepted_at            timestamptz,
  ready_at               timestamptz,
  collected_at           timestamptz,
  collected_via          text CHECK (collected_via IN ('OTP','MANUAL_OVERRIDE')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  -- A pre-order always has a pickup slot; a walk-in QR order never does.
  CHECK ((order_source = 'PREORDER' AND slot_id IS NOT NULL) OR (order_source = 'WALKIN_QR' AND slot_id IS NULL))
);
CREATE INDEX orders_shop_status_idx ON orders (shop_id, status);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX orders_slot_idx ON orders (slot_id);
CREATE INDEX orders_created_idx ON orders (created_at);

-- Item, price and modifier snapshot taken at checkout; later menu edits never change it.
CREATE TABLE order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id          uuid NOT NULL REFERENCES menu_items(id),
  name_snapshot         text NOT NULL,
  base_price_paise      bigint NOT NULL CHECK (base_price_paise >= 0),
  modifiers             jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{id, group, name, pricePaise}]
  modifiers_paise       bigint NOT NULL DEFAULT 0 CHECK (modifiers_paise >= 0),
  unit_price_paise      bigint NOT NULL CHECK (unit_price_paise >= 0),
  quantity              integer NOT NULL CHECK (quantity > 0),
  line_total_paise      bigint NOT NULL CHECK (line_total_paise >= 0),
  notes                 text NOT NULL DEFAULT ''              -- cooking instructions, printed on the kitchen slip
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE order_events (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  actor_type  text NOT NULL,   -- STUDENT | VENDOR | ADMIN | SYSTEM | WEBHOOK
  actor_id    text,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, id);

-- One provider order per QuickPick order.
CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL UNIQUE REFERENCES orders(id),
  provider           text NOT NULL,
  provider_ref       text NOT NULL UNIQUE,
  amount_paise       bigint NOT NULL CHECK (amount_paise >= 0),
  currency           text NOT NULL DEFAULT 'INR',
  status             text NOT NULL DEFAULT 'INITIATED',
  idempotency_key    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_status_idx ON payments (status, created_at);

-- Every hosted-checkout session the student opens for a payment (retries after a failure create new attempts).
CREATE TABLE payment_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id    uuid NOT NULL REFERENCES payments(id),
  order_id      uuid NOT NULL REFERENCES orders(id),
  attempt_no    integer NOT NULL,
  session_ref   text NOT NULL UNIQUE,
  checkout_url  text,
  return_url    text,
  status        text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','SUCCEEDED','FAILED','ABANDONED')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, attempt_no)
);

CREATE TABLE refunds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      uuid NOT NULL REFERENCES payments(id),
  order_id        uuid NOT NULL REFERENCES orders(id),
  amount_paise    bigint NOT NULL CHECK (amount_paise > 0),
  reason          text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSED','FAILED')),
  provider_ref    text UNIQUE,
  failure_reason  text,
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);
CREATE INDEX refunds_order_idx ON refunds (order_id);

-- Planned allocation of a paid order: vendor food entitlement, QuickPick fee, tax. Settled separately.
CREATE TABLE payment_splits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders(id),
  payment_id       uuid NOT NULL REFERENCES payments(id),
  beneficiary_type text NOT NULL CHECK (beneficiary_type IN ('VENDOR','PLATFORM','TAX')),
  shop_id          uuid REFERENCES shops(id),
  vendor_id        uuid REFERENCES vendors(id),
  amount_paise     bigint NOT NULL CHECK (amount_paise >= 0),
  status           text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','REVERSED','SETTLED')),
  settlement_id    uuid,
  provider_ref     text,
  UNIQUE (order_id, beneficiary_type)
);
CREATE INDEX payment_splits_shop_idx ON payment_splits (shop_id, status);

CREATE TABLE settlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid NOT NULL REFERENCES shops(id),
  vendor_id        uuid REFERENCES vendors(id),
  provider_ref     text,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  order_count      integer NOT NULL DEFAULT 0,
  gross_paise      bigint NOT NULL DEFAULT 0,
  adjustment_paise bigint NOT NULL DEFAULT 0,
  net_paise        bigint NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING','PAID','FAILED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, period_start, period_end)
);

-- Differences found when comparing our records with the provider (payments, refunds, settlements).
CREATE TABLE reconciliation_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('PAYMENT','REFUND','SETTLEMENT')),
  reference        text NOT NULL,
  order_id         uuid REFERENCES orders(id),
  expected_status  text,
  provider_status  text,
  expected_paise   bigint,
  actual_paise     bigint,
  action           text NOT NULL DEFAULT 'NONE',
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','AUTO_RESOLVED','RESOLVED')),
  notes            text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id                bigserial PRIMARY KEY,
  provider          text NOT NULL,
  external_event_id text NOT NULL,
  event_type        text NOT NULL,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  result            text,
  UNIQUE (provider, external_event_id)
);

-- Tablets (QuickPick property, loaned to shops). install_id is generated by the vendor app on first launch.
CREATE TABLE vendor_devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_tag       text UNIQUE,
  install_id      text UNIQUE,
  model           text NOT NULL DEFAULT '',
  platform        text NOT NULL DEFAULT 'unknown',
  app_version     text,
  shop_id         uuid REFERENCES shops(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'IN_STOCK' CHECK (status IN ('IN_STOCK','LOANED','RETURNED','LOST','DAMAGED')),
  condition_notes text NOT NULL DEFAULT '',
  last_seen_at    timestamptz,
  assigned_at     timestamptz,
  returned_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE printer_devices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  vendor_device_id uuid REFERENCES vendor_devices(id) ON DELETE SET NULL,
  name             text NOT NULL,
  model            text NOT NULL DEFAULT '',
  connection       text NOT NULL CHECK (connection IN ('BLUETOOTH','NETWORK','SIMULATED')),
  address          text NOT NULL DEFAULT '',     -- Bluetooth MAC or host:port; empty for SIMULATED
  paper_width_mm   integer NOT NULL DEFAULT 80 CHECK (paper_width_mm IN (58, 80)),
  auto_print       boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('UNKNOWN','ONLINE','OFFLINE','PAPER_OUT','ERROR')),
  last_error       text,
  last_status_at   timestamptz,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX printer_devices_shop_idx ON printer_devices (shop_id);

-- Kitchen slips. Created in the same transaction as vendor acceptance, so a paid+accepted order always has one.
CREATE TABLE print_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             uuid NOT NULL REFERENCES orders(id),
  shop_id              uuid NOT NULL REFERENCES shops(id),
  printer_id           uuid REFERENCES printer_devices(id) ON DELETE SET NULL,
  copy_number          integer NOT NULL DEFAULT 1,   -- 1 = original; 2+ = reprint (printed as a duplicate)
  reason               text NOT NULL CHECK (reason IN ('AUTO_ON_ACCEPT','MANUAL_REPRINT')),
  status               text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CLAIMED','PRINTED','FAILED','CANCELLED')),
  attempts             integer NOT NULL DEFAULT 0,
  max_attempts         integer NOT NULL DEFAULT 3,
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  claimed_by_device_id uuid REFERENCES vendor_devices(id) ON DELETE SET NULL,
  claim_expires_at     timestamptz,
  last_error           text,
  payload              jsonb NOT NULL,
  requested_by         uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  printed_at           timestamptz,
  UNIQUE (order_id, copy_number)
);
CREATE INDEX print_jobs_shop_status_idx ON print_jobs (shop_id, status, next_attempt_at);

-- Collection OTP: HMAC hash for verification + AES-GCM ciphertext so only the owning student can be shown it.
CREATE TABLE pickup_otps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL UNIQUE REFERENCES orders(id),
  otp_hash        text NOT NULL,
  otp_ciphertext  text NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','USED','LOCKED','EXPIRED','REVOKED')),
  failed_attempts integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  expires_at      timestamptz,             -- set when the order becomes READY
  revealed_at     timestamptz,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pickup_otp_attempts (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id),
  actor_id    uuid REFERENCES users(id),
  outcome     text NOT NULL CHECK (outcome IN ('SUCCESS','MISMATCH','EXPIRED','LOCKED','ALREADY_USED','NOT_READY','OVERRIDE')),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pickup_otp_attempts_order_idx ON pickup_otp_attempts (order_id, id);

-- Device push tokens (FCM). One student can have several devices.
CREATE TABLE push_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        text NOT NULL UNIQUE,
  platform     text NOT NULL DEFAULT 'WEB' CHECK (platform IN ('WEB','ANDROID','IOS')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  disabled_at  timestamptz
);

-- Notification outbox + delivery log. IN_APP rows are the always-available fallback shown inside the app.
CREATE TABLE notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  order_id            uuid REFERENCES orders(id),
  type                text NOT NULL,
  channel             text NOT NULL CHECK (channel IN ('PUSH','SMS','IN_APP')),
  title               text NOT NULL,
  body                text NOT NULL,
  data                jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','SIMULATED','FAILED','SKIPPED')),
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 4,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  last_error          text,
  provider_message_id text,
  dedupe_key          text UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  read_at             timestamptz
);
CREATE INDEX notifications_pending_idx ON notifications (status, next_attempt_at);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE complaints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  category    text NOT NULL,
  description text NOT NULL,
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED')),
  resolution  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  actor_id    uuid,
  actor_role  text,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

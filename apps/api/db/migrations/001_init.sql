-- CloudConnect AI — core schema (PostgreSQL 15+)
-- Multi-tenant: every tenant-owned row carries org_id; enforced in the service layer AND by RLS
-- (see 002_rls.sql). High-volume tables (calls, messages, audit_logs) are designed for
-- monthly range partitioning via pg_partman in production (see docs/DATABASE.md).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE member_role AS ENUM ('SUPER_ADMIN','COMPANY_OWNER','ADMINISTRATOR','BILLING_ADMIN','MANAGER','SUPERVISOR','AGENT','RECEPTIONIST','EMPLOYEE','READ_ONLY');
CREATE TYPE presence_status AS ENUM ('available','busy','on_call','in_meeting','away','dnd','offline');
CREATE TYPE number_type AS ENUM ('local','toll_free','vanity','international','temporary');
CREATE TYPE number_status AS ENUM ('active','porting','pending','released');
CREATE TYPE call_direction AS ENUM ('inbound','outbound','internal');
CREATE TYPE call_status AS ENUM ('queued','ringing','in_progress','on_hold','completed','busy','no_answer','failed','canceled','voicemail','rejected');
CREATE TYPE msg_direction AS ENUM ('inbound','outbound');
CREATE TYPE msg_status AS ENUM ('scheduled','queued','sent','delivered','read','failed','received');
CREATE TYPE sub_status AS ENUM ('trialing','active','past_due','canceled','incomplete');

-- ───────────────────────── Tenancy & identity ─────────────────────────
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          citext UNIQUE NOT NULL,
  timezone      text NOT NULL DEFAULT 'UTC',
  country       char(2) NOT NULL DEFAULT 'US',
  currency      char(3) NOT NULL DEFAULT 'USD',
  default_language text NOT NULL DEFAULT 'en-US',
  data_region   text NOT NULL DEFAULT 'us-east-1',
  settings      jsonb NOT NULL DEFAULT '{}',          -- recording policy, retention days, AI toggles
  hipaa_enabled boolean NOT NULL DEFAULT false,
  sso_config    jsonb,                                -- SAML/OIDC metadata
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email          citext NOT NULL,
  password_hash  text,                                 -- null for SSO-only users
  first_name     text NOT NULL,
  last_name      text NOT NULL DEFAULT '',
  role           member_role NOT NULL DEFAULT 'EMPLOYEE',
  title          text,
  department     text,
  avatar_url     text,
  timezone       text,
  language       text NOT NULL DEFAULT 'en-US',
  presence       presence_status NOT NULL DEFAULT 'offline',
  presence_note  text,
  mfa_secret     text,                                 -- AES-GCM encrypted TOTP secret
  mfa_enabled    boolean NOT NULL DEFAULT false,
  email_verified boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','suspended')),
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (org_id, email)
);
CREATE UNIQUE INDEX users_email_global ON users (email) WHERE deleted_at IS NULL;

CREATE TABLE oauth_identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('google','microsoft','apple','saml','oidc')),
  subject     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,              -- sha256 of opaque refresh token
  family_id          uuid NOT NULL,                     -- rotation family for reuse detection
  device_id          uuid,
  ip                 inet,
  user_agent         text,
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('web','ios','android','windows','macos','linux','desk_phone','sip')),
  name         text NOT NULL,
  push_token   text,                                   -- APNs/FCM/VoIP push token
  mac_address  macaddr,                                -- desk phone provisioning
  sip_username text UNIQUE,
  sip_password_hash text,
  verified     boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE TABLE team_members (
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  is_lead boolean NOT NULL DEFAULT false,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  prefix      text NOT NULL,                           -- shown to user: cc_live_ab12…
  key_hash    text NOT NULL UNIQUE,
  scopes      text[] NOT NULL DEFAULT '{}',
  created_by  uuid REFERENCES users(id),
  last_used_at timestamptz,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Phone system ─────────────────────────
CREATE TABLE extensions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number     text NOT NULL CHECK (number ~ '^[0-9]{2,6}$'),
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  kind       text NOT NULL DEFAULT 'user' CHECK (kind IN ('user','ring_group','ivr','queue','voicemail','shared_line','park')),
  forwarding jsonb NOT NULL DEFAULT '{}',              -- {always?, busy?, noAnswer?, simultaneous:[...]}
  dnd        boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE routing_flows (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  definition jsonb NOT NULL,                           -- @cloudconnect/shared RoutingFlow
  version    int NOT NULL DEFAULT 1,
  published  boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE phone_numbers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  e164            text NOT NULL UNIQUE CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  type            number_type NOT NULL DEFAULT 'local',
  status          number_status NOT NULL DEFAULT 'active',
  country         char(2) NOT NULL,
  label           text,
  vanity          text,
  provider        text NOT NULL DEFAULT 'twilio' CHECK (provider IN ('twilio','telnyx','signalwire','plivo','vonage','sip_trunk')),
  provider_sid    text,
  capabilities    text[] NOT NULL DEFAULT '{voice,sms}',
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  routing_flow_id uuid REFERENCES routing_flows(id) ON DELETE SET NULL,
  caller_id_name  text,
  expires_at      timestamptz,                         -- temporary numbers
  monthly_cost_cents int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX phone_numbers_org ON phone_numbers (org_id);

CREATE TABLE port_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  numbers      text[] NOT NULL,
  losing_carrier text NOT NULL,
  account_number text NOT NULL,
  pin_encrypted  text,
  loa_document_key text,                               -- S3 key of signed LOA
  status       text NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft','submitted','foc_received','completed','rejected')),
  foc_date     date,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sip_trunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  provider    text NOT NULL,
  termination_uri text NOT NULL,
  auth        jsonb NOT NULL DEFAULT '{}',             -- {ipAcl:[...], credentialsRef}
  max_channels int NOT NULL DEFAULT 30,
  srtp_required boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blocked_numbers (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  e164       text NOT NULL,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, e164)
);

CREATE TABLE voicemail_boxes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  greeting_url text,
  email_delivery boolean NOT NULL DEFAULT true,
  sms_notify  text,                                    -- E.164 to notify
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Calls ─────────────────────────
CREATE TABLE calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  provider_call_id text,
  parent_call_id  uuid,                                -- legs of transfers/conferences
  direction       call_direction NOT NULL,
  status          call_status NOT NULL DEFAULT 'queued',
  from_number     text NOT NULL,
  to_number       text NOT NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  phone_number_id uuid REFERENCES phone_numbers(id) ON DELETE SET NULL,
  queue_id        text,
  routing_path    jsonb NOT NULL DEFAULT '[]',          -- node ids visited
  started_at      timestamptz NOT NULL DEFAULT now(),
  answered_at     timestamptz,
  ended_at        timestamptz,
  duration_seconds int GENERATED ALWAYS AS (CASE WHEN ended_at IS NOT NULL AND answered_at IS NOT NULL THEN EXTRACT(EPOCH FROM (ended_at - answered_at))::int ELSE 0 END) STORED,
  wait_seconds    int,
  cost_cents      int NOT NULL DEFAULT 0,
  country         char(2),
  mos_score       numeric(3,2),                         -- call quality (1.0–5.0)
  jitter_ms       int,
  packet_loss_pct numeric(5,2),
  spam_score      numeric(3,2),
  tags            text[] NOT NULL DEFAULT '{}',
  UNIQUE (provider, provider_call_id)
);
CREATE INDEX calls_org_started ON calls (org_id, started_at DESC);
CREATE INDEX calls_user_started ON calls (user_id, started_at DESC);

CREATE TABLE call_events (                              -- hold, transfer, park, barge, whisper…
  id         bigserial PRIMARY KEY,
  call_id    uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  type       text NOT NULL,
  actor_id   uuid REFERENCES users(id),
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_events_call ON call_events (call_id);

CREATE TABLE recordings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id     uuid REFERENCES calls(id) ON DELETE CASCADE,
  meeting_id  uuid,
  storage_key text NOT NULL,                            -- s3://bucket/org/yyyy/mm/id.mp3 (SSE-KMS)
  duration_seconds int NOT NULL DEFAULT 0,
  channels    int NOT NULL DEFAULT 2,
  status      text NOT NULL DEFAULT 'processing' CHECK (status IN ('recording','paused','processing','ready','failed','deleted')),
  retain_until timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voicemails (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  mailbox_id  uuid REFERENCES voicemail_boxes(id) ON DELETE CASCADE,
  call_id     uuid REFERENCES calls(id) ON DELETE SET NULL,
  from_number text NOT NULL,
  storage_key text NOT NULL,
  duration_seconds int NOT NULL DEFAULT 0,
  transcript  text,
  ai_summary  text,
  is_read     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voicemails_mailbox ON voicemails (mailbox_id, created_at DESC);

CREATE TABLE transcripts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('call','meeting','voicemail')),
  source_id  uuid NOT NULL,
  language   text NOT NULL DEFAULT 'en-US',
  segments   jsonb NOT NULL DEFAULT '[]',              -- [{speaker, start, end, text}]
  full_text  text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);

CREATE TABLE ai_insights (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id   uuid NOT NULL,
  summary     text,
  sentiment   text CHECK (sentiment IN ('positive','neutral','negative','mixed')),
  sentiment_score numeric(4,3),
  action_items jsonb NOT NULL DEFAULT '[]',
  keywords    text[] NOT NULL DEFAULT '{}',
  call_score  int CHECK (call_score BETWEEN 0 AND 100),
  coaching    jsonb NOT NULL DEFAULT '[]',
  model       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);

-- ───────────────────────── Messaging ─────────────────────────
CREATE TABLE conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('sms','group_sms','team_chat','direct_chat')),
  phone_number_id uuid REFERENCES phone_numbers(id) ON DELETE SET NULL,
  title        text,
  participants text[] NOT NULL DEFAULT '{}',           -- E.164s for SMS, user ids for chat
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_org_last ON conversations (org_id, last_message_at DESC);
CREATE UNIQUE INDEX conversations_sms_unique ON conversations (org_id, phone_number_id, participants) WHERE kind IN ('sms','group_sms');

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction       msg_direction NOT NULL,
  status          msg_status NOT NULL DEFAULT 'queued',
  sender_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  from_address    text NOT NULL,
  to_addresses    text[] NOT NULL,
  body            text NOT NULL DEFAULT '',
  media           jsonb NOT NULL DEFAULT '[]',          -- [{key, contentType, size}]
  provider_message_id text,
  segments        int NOT NULL DEFAULT 1,
  cost_cents      int NOT NULL DEFAULT 0,
  scheduled_at    timestamptz,
  read_at         timestamptz,
  campaign_id     uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv ON messages (conversation_id, created_at DESC);
CREATE INDEX messages_scheduled ON messages (scheduled_at) WHERE status = 'scheduled';

CREATE TABLE sms_templates (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name   text NOT NULL,
  body   text NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE auto_replies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone_number_id uuid REFERENCES phone_numbers(id) ON DELETE CASCADE,
  trigger    text NOT NULL CHECK (trigger IN ('after_hours','keyword','always','missed_call')),
  keyword    text,
  body       text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true
);

CREATE TABLE campaigns (                                  -- bulk & broadcast messaging
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  from_number_id uuid REFERENCES phone_numbers(id),
  body       text NOT NULL,
  contact_group_id uuid,
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','completed','canceled')),
  scheduled_at timestamptz,
  stats      jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- SMS opt-outs (TCPA / CTIA compliance)
CREATE TABLE sms_opt_outs (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  e164   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, e164)
);

-- ───────────────────────── Contacts ─────────────────────────
CREATE TABLE contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id    uuid REFERENCES users(id) ON DELETE CASCADE,  -- null = shared company contact
  first_name  text NOT NULL DEFAULT '',
  last_name   text NOT NULL DEFAULT '',
  company     text,
  emails      citext[] NOT NULL DEFAULT '{}',
  phones      text[] NOT NULL DEFAULT '{}',
  tags        text[] NOT NULL DEFAULT '{}',
  favorite    boolean NOT NULL DEFAULT false,
  crm_source  text,
  crm_id      text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_org ON contacts (org_id);
CREATE INDEX contacts_phones ON contacts USING gin (phones);
CREATE INDEX contacts_tags ON contacts USING gin (tags);

CREATE TABLE contact_groups (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name   text NOT NULL,
  contact_ids uuid[] NOT NULL DEFAULT '{}',
  UNIQUE (org_id, name)
);

-- ───────────────────────── Meetings ─────────────────────────
CREATE TABLE meetings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  host_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL,
  join_code     text NOT NULL UNIQUE,
  passcode_hash text,
  mode          text NOT NULL DEFAULT 'meeting' CHECK (mode IN ('meeting','webinar')),
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  timezone      text,
  waiting_room  boolean NOT NULL DEFAULT true,
  auto_record   boolean NOT NULL DEFAULT false,
  live_captions boolean NOT NULL DEFAULT true,
  calendar_event_id text,
  calendar_provider text,
  started_at    timestamptz,
  ended_at      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meeting_participants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  email       citext,
  role        text NOT NULL DEFAULT 'attendee' CHECK (role IN ('host','cohost','panelist','attendee')),
  breakout_room text,
  joined_at   timestamptz,
  left_at     timestamptz
);

-- ───────────────────────── Billing ─────────────────────────
CREATE TABLE subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id            text NOT NULL DEFAULT 'starter',
  interval           text NOT NULL DEFAULT 'month' CHECK (interval IN ('month','year')),
  seats              int NOT NULL DEFAULT 1 CHECK (seats > 0),
  status             sub_status NOT NULL DEFAULT 'trialing',
  stripe_customer_id text,
  stripe_subscription_id text,
  trial_ends_at      timestamptz,
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz NOT NULL DEFAULT now() + interval '1 month',
  coupon_code        text,
  tax_id             text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_records (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('minutes_domestic','minutes_international','minutes_toll_free','sms','mms','ai_minutes','storage_gb','number')),
  quantity    numeric NOT NULL,
  cost_cents  int NOT NULL DEFAULT 0,
  source_id   uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_org_time ON usage_records (org_id, occurred_at);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number        text NOT NULL UNIQUE,
  currency      char(3) NOT NULL DEFAULT 'USD',
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  lines         jsonb NOT NULL,
  subtotal_cents int NOT NULL,
  discount_cents int NOT NULL DEFAULT 0,
  tax_cents     int NOT NULL DEFAULT 0,
  total_cents   int NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','paid','void','uncollectible')),
  stripe_invoice_id text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coupons (
  code         text PRIMARY KEY,
  percent_off  int CHECK (percent_off BETWEEN 1 AND 100),
  valid_until  timestamptz,
  max_redemptions int,
  redemptions  int NOT NULL DEFAULT 0
);

CREATE TABLE rates (
  prefix          text PRIMARY KEY,
  country         text NOT NULL,
  per_minute_cents int NOT NULL,
  sms_cents       int NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Platform ─────────────────────────
CREATE TABLE webhooks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url        text NOT NULL CHECK (url ~ '^https://'),
  events     text[] NOT NULL,
  secret     text NOT NULL,                            -- HMAC-SHA256 signing secret
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id           bigserial PRIMARY KEY,
  webhook_id   uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event        text NOT NULL,
  payload      jsonb NOT NULL,
  status_code  int,
  attempt      int NOT NULL DEFAULT 1,
  next_retry_at timestamptz,
  delivered_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integrations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider    text NOT NULL,                           -- salesforce, hubspot, zoho, slack, teams, google, m365, zapier, quickbooks, calendly, zoom
  credentials_encrypted text NOT NULL,
  settings    jsonb NOT NULL DEFAULT '{}',
  connected_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider)
);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id    uuid,
  actor_type  text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','api_key','system')),
  action      text NOT NULL,                           -- e.g. user.create, number.release
  target_type text,
  target_id   text,
  ip          inet,
  user_agent  text,
  metadata    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_time ON audit_logs (org_id, created_at DESC);

CREATE TABLE fraud_events (
  id         bigserial PRIMARY KEY,
  org_id     uuid REFERENCES organizations(id) ON DELETE CASCADE,
  kind       text NOT NULL,                            -- toll_fraud, irsf, velocity, impossible_travel
  score      numeric(3,2) NOT NULL,
  details    jsonb NOT NULL DEFAULT '{}',
  action     text NOT NULL DEFAULT 'flagged',
  created_at timestamptz NOT NULL DEFAULT now()
);

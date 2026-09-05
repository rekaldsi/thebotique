-- Tables 2 and 3 of a hard budget of 3.
--
-- Deliberately minimal. The previous version of this product shipped 29
-- tables for one user, 24 of them permanently empty. Nothing goes in here
-- that is not required to send someone an email when a thing they watch
-- changes, or to bill them for it.

CREATE TABLE IF NOT EXISTS drift_accounts (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT        NOT NULL UNIQUE,
  -- Magic-link tokens are stored HASHED. A leaked database read must not
  -- hand an attacker a working login link.
  login_hash      TEXT,
  login_expires   TIMESTAMPTZ,
  plan            TEXT        NOT NULL DEFAULT 'free',
  stripe_customer TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ,
  -- California ARL (AB 2863) requires retaining proof of affirmative
  -- consent to auto-renewal for 3+ years. Columns exist now so the consent
  -- event can be recorded at the moment of purchase rather than
  -- retrofitted afterwards.
  renewal_consent_at   TIMESTAMPTZ,
  renewal_consent_ip   TEXT,
  renewal_consent_text TEXT
);

CREATE TABLE IF NOT EXISTS drift_watches (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT      NOT NULL REFERENCES drift_accounts(id) ON DELETE CASCADE,
  source       TEXT        NOT NULL,
  slug         TEXT        NOT NULL,
  -- The content hash the subscriber has already been told about. Alerting
  -- compares against this rather than against "latest", so a missed run
  -- cannot silently swallow a change.
  notified_sha TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, source, slug)
);

CREATE INDEX IF NOT EXISTS drift_watches_account ON drift_watches (account_id);
CREATE INDEX IF NOT EXISTS drift_watches_artifact ON drift_watches (source, slug);

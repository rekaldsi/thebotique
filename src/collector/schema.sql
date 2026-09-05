-- Agent-extension supply-chain snapshots.
--
-- Append-only. One row per (source, slug, observed version) per fetch.
-- The whole point is the diff across time, so we never UPDATE and never
-- DELETE -- a row is a dated observation, not current state.
--
-- Table budget: this is 1 of a maximum of 3.

CREATE TABLE IF NOT EXISTS artifact_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT        NOT NULL,   -- 'mcp-registry' | 'clawhub'
  slug          TEXT        NOT NULL,   -- stable identifier within source
  version       TEXT,                   -- as reported upstream, may be null
  repo_url      TEXT,                   -- source repo, when published
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  upstream_at   TIMESTAMPTZ,            -- upstream's own updatedAt
  content_sha   TEXT        NOT NULL,   -- sha256 of the normalized record
  installs      INTEGER,
  downloads     INTEGER,
  versions      INTEGER,                -- lifetime version count upstream
  repo_status   TEXT,                   -- 'alive' | 'stale' | 'gone' | 'unknown'
  repo_pushed_at TIMESTAMPTZ,
  raw           JSONB       NOT NULL    -- the normalized record we hashed
);

-- The query that matters: "what did this look like over time".
CREATE INDEX IF NOT EXISTS artifact_snapshots_ident
  ON artifact_snapshots (source, slug, fetched_at DESC);

-- Cheap dedupe: skip writing when the content hash is unchanged from the
-- previous fetch. Partial history with gaps is worse than useless for a
-- product that sells "what changed", so we keep every CHANGE but not every
-- identical re-fetch.
CREATE INDEX IF NOT EXISTS artifact_snapshots_sha
  ON artifact_snapshots (source, slug, content_sha);

-- Feed page: "recently changed", across all sources.
CREATE INDEX IF NOT EXISTS artifact_snapshots_recent
  ON artifact_snapshots (fetched_at DESC);

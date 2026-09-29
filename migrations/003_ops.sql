ALTER TABLE projects ADD COLUMN last_request_at timestamptz;

CREATE TABLE usage_daily (
  ref          text NOT NULL REFERENCES projects ON DELETE CASCADE,
  day          date NOT NULL,
  requests     bigint NOT NULL DEFAULT 0,
  errors       bigint NOT NULL DEFAULT 0,
  egress_bytes bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (ref, day)
);

-- Latest measurement of what each project stores (refreshed by housekeeping).
CREATE TABLE usage_current (
  ref           text PRIMARY KEY REFERENCES projects ON DELETE CASCADE,
  measured_at   timestamptz NOT NULL DEFAULT now(),
  db_bytes      bigint NOT NULL DEFAULT 0,
  storage_bytes bigint NOT NULL DEFAULT 0
);

CREATE TABLE backups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref        text NOT NULL REFERENCES projects ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('manual', 'scheduled')),
  status     text NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  size_bytes bigint,
  sha256     text,
  path       text,
  note       text,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX backups_ref_created ON backups (ref, created_at DESC);

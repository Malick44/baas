CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Tokens stand in for user accounts until the dashboard adds sign-in. Only a hash is stored.
CREATE TABLE api_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  name       text NOT NULL,
  role       text NOT NULL CHECK (role IN ('developer', 'admin', 'owner')),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE projects (
  ref        text PRIMARY KEY CHECK (ref ~ '^[a-z0-9]{20}$'),
  org_id     uuid NOT NULL REFERENCES organizations,
  name       text NOT NULL,
  status     text NOT NULL CHECK (status IN ('provisioning', 'active', 'paused', 'failed', 'deleted', 'purged')),
  db_name    text NOT NULL UNIQUE,
  plan       text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
-- A name is free again once its project is failed, deleted or purged.
CREATE UNIQUE INDEX projects_org_name ON projects (org_id, name)
  WHERE status NOT IN ('failed', 'deleted', 'purged');

-- *_enc columns hold vault ciphertext bound to the project ref. The anon key is public by design.
CREATE TABLE project_secrets (
  ref             text PRIMARY KEY REFERENCES projects ON DELETE CASCADE,
  jwt_secret_enc  text NOT NULL,
  service_key_enc text NOT NULL,
  db_password_enc text NOT NULL,
  anon_key        text NOT NULL,
  key_version     int  NOT NULL DEFAULT 1
);

CREATE TABLE project_settings (
  ref      text PRIMARY KEY REFERENCES projects ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE audit_log (
  id     bigserial PRIMARY KEY,
  org_id uuid,
  actor  text NOT NULL,
  action text NOT NULL,
  target text,
  meta   jsonb NOT NULL DEFAULT '{}',
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_at ON audit_log (org_id, at DESC);

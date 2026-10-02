-- Per-user dashboard accounts. A member belongs to one organisation; signing in mints an expiring row in api_tokens
-- (member_id set), so every existing route keeps authenticating the same way and a member's role is read live.
CREATE TABLE members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  email         text NOT NULL,
  name          text,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('developer', 'admin', 'owner')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX members_email ON members (lower(email));
CREATE INDEX members_org ON members (org_id);

CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('developer', 'admin', 'owner')),
  token_hash  text NOT NULL UNIQUE,
  invited_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz
);
CREATE UNIQUE INDEX invites_pending ON invites (org_id, lower(email)) WHERE accepted_at IS NULL;

ALTER TABLE api_tokens
  ADD COLUMN member_id  uuid REFERENCES members ON DELETE CASCADE,
  ADD COLUMN expires_at timestamptz;
CREATE INDEX api_tokens_member ON api_tokens (member_id) WHERE member_id IS NOT NULL;

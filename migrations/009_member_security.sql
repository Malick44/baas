-- Password reset links and authenticator-app (TOTP) sign-in for dashboard members.
CREATE TABLE member_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id  uuid NOT NULL REFERENCES members ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX member_resets_member ON member_resets (member_id);

-- One authenticator per member. The secret is sealed with the platform key; last_used_step stops a code being used twice.
CREATE TABLE member_factors (
  member_id      uuid PRIMARY KEY REFERENCES members ON DELETE CASCADE,
  secret_enc     text NOT NULL,
  status         text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'verified')),
  last_used_step bigint NOT NULL DEFAULT -1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  verified_at    timestamptz
);

CREATE TABLE member_recovery_codes (
  member_id uuid NOT NULL REFERENCES members ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at   timestamptz,
  PRIMARY KEY (member_id, code_hash)
);

-- The half-signed-in state between a correct password and a correct code.
CREATE TABLE member_mfa_tickets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id  uuid NOT NULL REFERENCES members ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  attempts   int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);
CREATE INDEX member_mfa_tickets_member ON member_mfa_tickets (member_id);

-- Existing accounts keep their current sign-in behavior. Only temporary passwords require replacement.
ALTER TABLE members ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- Survives organization deletion so a restart can never recreate the initial privileged accounts.
CREATE TABLE initial_members_bootstrap (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  outcome text NOT NULL CHECK (outcome IN ('created', 'skipped_existing')),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE functions (
  ref        text NOT NULL REFERENCES projects ON DELETE CASCADE,
  name       text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  source     text NOT NULL,
  verify_jwt boolean NOT NULL DEFAULT true,
  version    int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ref, name)
);

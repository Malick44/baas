-- Running several baas processes against one control database: shared rate limits, a node list, and logs readable from any node.
CREATE UNLOGGED TABLE rate_limits (
  key        text PRIMARY KEY,
  count      int NOT NULL,
  window_end timestamptz NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits (window_end);

CREATE UNLOGGED TABLE nodes (
  id         uuid PRIMARY KEY,
  host       text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  seen_at    timestamptz NOT NULL DEFAULT now(),
  -- Written by the node that holds the leadership lock, for the operator's view; the lock itself decides who leads.
  leader     boolean NOT NULL DEFAULT false
);

-- The newest requests per project, written in batches by whichever node served them. A debugging aid, not an audit trail.
CREATE UNLOGGED TABLE request_logs (
  id     bigserial PRIMARY KEY,
  ref    text NOT NULL,
  at     timestamptz NOT NULL,
  method text NOT NULL,
  path   text NOT NULL,
  status int NOT NULL,
  ms     int NOT NULL
);
CREATE INDEX request_logs_ref ON request_logs (ref, id DESC);

CREATE UNLOGGED TABLE function_logs (
  id     bigserial PRIMARY KEY,
  ref    text NOT NULL,
  at     timestamptz NOT NULL,
  name   text NOT NULL,
  status int,
  ms     int,
  note   text
);
CREATE INDEX function_logs_ref ON function_logs (ref, id DESC);

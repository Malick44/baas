-- Requests per project, per hour, per service, split by outcome (for the overview charts).
CREATE TABLE usage_hourly (
  ref           text NOT NULL REFERENCES projects ON DELETE CASCADE,
  hour          timestamptz NOT NULL,
  service       text NOT NULL CHECK (service IN ('rest', 'auth', 'storage', 'functions', 'realtime', 'other')),
  requests      int NOT NULL DEFAULT 0,
  client_errors int NOT NULL DEFAULT 0,
  server_errors int NOT NULL DEFAULT 0,
  PRIMARY KEY (ref, hour, service)
);

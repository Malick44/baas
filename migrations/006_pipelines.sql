-- Pipelines: deliver a project's row changes to a webhook. The delivery cursor lives in the project's own database
-- (realtime.pipeline_cursors) so it moves together with the change log it points into.
CREATE TABLE pipelines (
  id                   uuid PRIMARY KEY,
  ref                  text NOT NULL REFERENCES projects ON DELETE CASCADE,
  name                 text NOT NULL,
  tables               text[] NOT NULL,
  events               text[] NOT NULL DEFAULT '{INSERT,UPDATE,DELETE}',
  url                  text NOT NULL,
  secret_enc           text NOT NULL,
  include_rows         boolean NOT NULL DEFAULT true,
  enabled              boolean NOT NULL DEFAULT true,
  disabled_reason      text,
  consecutive_failures int NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz,
  last_attempt_at      timestamptz,
  last_success_at      timestamptz,
  last_status          int,
  last_error           text,
  delivered            bigint NOT NULL DEFAULT 0,
  failed               bigint NOT NULL DEFAULT 0,
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ref, name)
);
CREATE INDEX pipelines_due ON pipelines (enabled, next_attempt_at);

CREATE TABLE pipeline_deliveries (
  id           bigserial PRIMARY KEY,
  pipeline_id  uuid NOT NULL REFERENCES pipelines ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL DEFAULT 'delivery' CHECK (kind IN ('delivery', 'test')),
  ok           boolean NOT NULL,
  status       int,
  ms           int,
  events       int NOT NULL DEFAULT 0,
  first_change bigint,
  last_change  bigint,
  error        text
);
CREATE INDEX pipeline_deliveries_by_pipeline ON pipeline_deliveries (pipeline_id, id DESC);

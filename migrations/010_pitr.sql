-- Point-in-time recovery: periodic base backups of the whole Postgres cluster. Together with the archived WAL they let
-- a scratch server replay history up to any moment, from which one project's database is extracted.
CREATE TABLE pitr_base_backups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status      text NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  path        text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  -- Taken from the server's clock after the backup ended, so any target at or after it is consistent.
  finished_at timestamptz,
  start_wal   text,
  size_bytes  bigint,
  error       text
);
CREATE INDEX pitr_base_backups_finished ON pitr_base_backups (finished_at DESC) WHERE status = 'complete';

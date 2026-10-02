-- Point-in-time recovery for every cluster, not only the main one: each cluster keeps its own base backups and has its own
-- WAL archive directory (as baas sees it), which the operator points that cluster's archive_command at.
ALTER TABLE clusters ADD COLUMN archive_dir text;
ALTER TABLE pitr_base_backups ADD COLUMN cluster_id text NOT NULL DEFAULT 'main' REFERENCES clusters ON DELETE CASCADE;
DROP INDEX pitr_base_backups_finished;
CREATE INDEX pitr_base_backups_finished ON pitr_base_backups (cluster_id, finished_at DESC) WHERE status = 'complete';

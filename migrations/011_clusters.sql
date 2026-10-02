-- Several Postgres clusters. Every project lives on exactly one; "main" is the cluster named in BAAS_PG_ADMIN_URL.
-- Admin URLs of added clusters are sealed with the platform key and never returned by the API.
CREATE TABLE clusters (
  id           text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  name         text NOT NULL,
  admin_url_enc text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draining')),
  max_projects int CHECK (max_projects > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO clusters (id, name) VALUES ('main', 'Primary cluster');

ALTER TABLE projects
  ADD COLUMN cluster_id text NOT NULL DEFAULT 'main' REFERENCES clusters,
  -- Set while a project is being copied to another cluster, so no second move starts and a crash can be cleaned up.
  ADD COLUMN moving_to text REFERENCES clusters;
CREATE INDEX projects_cluster ON projects (cluster_id);

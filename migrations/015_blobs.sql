-- Object bytes kept in Postgres instead of on a shared disk or in S3: BAAS_STORAGE_BACKEND=postgres. Chunked, so a file never has to
-- fit in one row, and logged (durable), unlike the coordination tables.
CREATE TABLE blob_objects (
  key        text PRIMARY KEY,
  size       bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE blob_chunks (
  key  text NOT NULL REFERENCES blob_objects ON DELETE CASCADE,
  idx  int NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (key, idx)
);

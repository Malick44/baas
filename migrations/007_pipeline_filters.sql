-- Optional row filters per table: { "orders": [{ "column": "status", "op": "eq", "value": "paid" }] }.
ALTER TABLE pipelines ADD COLUMN filters jsonb NOT NULL DEFAULT '{}';

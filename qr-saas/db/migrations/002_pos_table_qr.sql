ALTER TABLE dining_tables ADD COLUMN pos_table_id text;
ALTER TABLE dining_tables ADD COLUMN qr_ordering_until timestamptz;
ALTER TABLE dining_tables ADD UNIQUE (tenant_id, branch_id, pos_table_id);
CREATE INDEX table_sessions_table_expiry_idx ON table_sessions(table_id, expires_at)
  WHERE revoked_at IS NULL;

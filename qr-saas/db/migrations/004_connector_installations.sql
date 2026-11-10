CREATE TABLE connector_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (tenant_id, branch_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
CREATE UNIQUE INDEX connector_installations_one_active_per_branch
  ON connector_installations(tenant_id, branch_id) WHERE revoked_at IS NULL;
ALTER TABLE dining_tables ADD COLUMN pos_installation_id uuid;
ALTER TABLE dining_tables ADD COLUMN qr_session_generation uuid;
ALTER TABLE table_sessions ADD COLUMN qr_generation uuid;
ALTER TABLE dining_tables ADD FOREIGN KEY (tenant_id, branch_id, pos_installation_id)
  REFERENCES connector_installations(tenant_id, branch_id, id);

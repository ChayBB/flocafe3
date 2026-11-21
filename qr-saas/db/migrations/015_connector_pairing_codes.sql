-- One-time codes a new POS redeems for its connector token, so the token never travels by chat.
CREATE TABLE connector_pairing_codes (
  code_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  label text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
CREATE INDEX connector_pairing_codes_branch ON connector_pairing_codes(tenant_id, branch_id);

-- Only the owner role reads codes; request handlers running as qr_app never see them.
ALTER TABLE connector_pairing_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_pairing_codes FROM qr_app;

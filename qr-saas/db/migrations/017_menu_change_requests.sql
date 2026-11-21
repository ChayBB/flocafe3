-- Price and photo changes an owner makes on the web; the branch POS applies or rejects each one.
CREATE TABLE menu_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  menu_item_id uuid NOT NULL REFERENCES menu_items(id),
  pos_product_id text NOT NULL,
  pos_variant_id text,
  field text NOT NULL CHECK (field IN ('price', 'image')),
  base_value text,
  new_value text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'conflict', 'kept_pos', 'cancelled', 'superseded', 'failed')),
  force boolean NOT NULL DEFAULT false,
  pos_value text,
  detail text,
  requested_by uuid REFERENCES portal_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
CREATE INDEX menu_change_requests_branch_status ON menu_change_requests (tenant_id, branch_id, status, created_at);

ALTER TABLE menu_change_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON menu_change_requests TO qr_app
  USING (tenant_id = app_tenant_id() AND branch_id = app_branch_id())
  WITH CHECK (tenant_id = app_tenant_id() AND branch_id = app_branch_id());
GRANT SELECT, INSERT, UPDATE ON menu_change_requests TO qr_app;

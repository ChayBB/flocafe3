-- Cloud modules an administrator turns off per branch. A branch without a row has the module on.
CREATE TABLE branch_modules (
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  module text NOT NULL CHECK (module IN ('qr_ordering', 'menu_editing', 'reports')),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id, module),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
ALTER TABLE branch_modules ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON branch_modules TO qr_app
  USING (tenant_id = app_tenant_id() AND branch_id = app_branch_id());
REVOKE ALL ON branch_modules FROM qr_app;
GRANT SELECT ON branch_modules TO qr_app;

-- One aggregated business day per branch, published by the branch POS for the owner dashboard.
CREATE TABLE branch_daily_reports (
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  business_date date NOT NULL,
  report jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id, business_date),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
ALTER TABLE branch_daily_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON branch_daily_reports TO qr_app
  USING (tenant_id = app_tenant_id() AND branch_id = app_branch_id())
  WITH CHECK (tenant_id = app_tenant_id() AND branch_id = app_branch_id());
GRANT SELECT, INSERT, UPDATE ON branch_daily_reports TO qr_app;

-- Monthly sales targets an owner sets per branch.
CREATE TABLE branch_sales_targets (
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  target numeric(14, 2) NOT NULL CHECK (target >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id, month),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
ALTER TABLE branch_sales_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON branch_sales_targets FROM qr_app;

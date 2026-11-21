-- Tenant isolation: request handlers switch to qr_app with SET LOCAL ROLE after setting
-- app.tenant_id and app.branch_id, so every row they touch must belong to that branch.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qr_app') THEN
    CREATE ROLE qr_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT qr_app TO %I', current_user);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO qr_app', current_schema());
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO qr_app', current_schema());
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO qr_app', current_schema());
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qr_app', current_schema());
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO qr_app', current_schema());
END $$;

CREATE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app_branch_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.branch_id', true), '')::uuid $$;

DO $$
DECLARE
  scoped text;
BEGIN
  FOREACH scoped IN ARRAY ARRAY[
    'dining_tables', 'table_sessions', 'menu_items', 'orders', 'idempotency_records',
    'outbox_events', 'connector_deliveries', 'payments', 'audit_logs', 'connector_installations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped);
    EXECUTE format(
      'CREATE POLICY branch_scope ON %I TO qr_app
         USING (tenant_id = app_tenant_id() AND branch_id = app_branch_id())
         WITH CHECK (tenant_id = app_tenant_id() AND branch_id = app_branch_id())',
      scoped);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON tenants TO qr_app USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON branches TO qr_app
  USING (tenant_id = app_tenant_id() AND id = app_branch_id())
  WITH CHECK (tenant_id = app_tenant_id() AND id = app_branch_id());

ALTER TABLE menu_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON menu_images TO qr_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON order_items TO qr_app
  USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id))
  WITH CHECK (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id));

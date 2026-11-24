-- The store logo and cover the POS pushes for the guest page; images are content-addressed.
CREATE TABLE branding_images(
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK(name ~ '^[a-f0-9]{64}\.(webp|png|jpeg|gif)$'),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 1572864),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, name)
);
CREATE INDEX branding_images_name_idx ON branding_images(name);

-- Partial uploads: an image arrives in parts so each request fits the proxy body limit.
CREATE TABLE branding_uploads(
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  name text NOT NULL CHECK(name ~ '^[a-f0-9]{64}\.(webp|png|jpeg|gif)$'),
  bytes bytea NOT NULL CHECK(octet_length(bytes) <= 1572864),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, branch_id, name),
  FOREIGN KEY(tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);

ALTER TABLE branches
  ADD COLUMN store_logo text CHECK(store_logo ~ '^[a-f0-9]{64}\.(webp|png|jpeg|gif)$'),
  ADD COLUMN store_cover text CHECK(store_cover ~ '^[a-f0-9]{64}\.(webp|png|jpeg|gif)$'),
  ADD COLUMN branding_updated_at timestamptz;

ALTER TABLE branding_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON branding_images TO qr_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE branding_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON branding_uploads TO qr_app
  USING (tenant_id = app_tenant_id() AND branch_id = app_branch_id())
  WITH CHECK (tenant_id = app_tenant_id() AND branch_id = app_branch_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON branding_images, branding_uploads TO qr_app;

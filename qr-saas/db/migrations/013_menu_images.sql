CREATE TABLE menu_images(
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK(name ~ '^[a-f0-9]{64}\.(webp|png|jpeg|gif)$'),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 131072),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, name)
);
CREATE INDEX menu_images_name_idx ON menu_images(name);
ALTER TABLE menu_items ADD COLUMN image text CHECK(image ~ '^[a-f0-9]{64}\.(webp|png|jpeg|gif)$');

ALTER TABLE branches ADD COLUMN menu_revision uuid;
ALTER TABLE branches ADD COLUMN menu_revision_hash text;
ALTER TABLE menu_items ADD COLUMN category text;
ALTER TABLE menu_items ADD COLUMN pos_product_id text;
ALTER TABLE menu_items ADD COLUMN pos_variant_id text;

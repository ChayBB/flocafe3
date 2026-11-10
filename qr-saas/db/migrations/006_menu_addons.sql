ALTER TABLE menu_items ADD COLUMN addon_groups jsonb NOT NULL DEFAULT '[]';
ALTER TABLE order_items ADD COLUMN addons_snapshot jsonb NOT NULL DEFAULT '[]';

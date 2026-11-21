ALTER TABLE menu_items ADD COLUMN price_unit text CHECK (price_unit = 'kg');

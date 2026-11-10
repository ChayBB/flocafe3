ALTER TABLE order_items ADD COLUMN kitchen_status text
  CHECK (kitchen_status IN ('pending', 'preparing', 'ready', 'served', 'cancelled'));

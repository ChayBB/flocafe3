ALTER TABLE connector_deliveries ADD COLUMN pos_receipt_id uuid;
ALTER TABLE connector_deliveries ADD COLUMN pos_order_number text;
ALTER TABLE connector_deliveries ADD UNIQUE (tenant_id, branch_id, pos_receipt_id);

-- A table-QR guest asks for the bill on the Cloud; the branch POS picks the request up with its
-- table-state sync. The POS also shares each open table's bill so guests read POS totals.
ALTER TABLE dining_tables ADD COLUMN bill_requested_at timestamptz;
ALTER TABLE dining_tables ADD COLUMN pos_bill jsonb;

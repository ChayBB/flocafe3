ALTER TABLE branches ADD COLUMN guest_scroll_percent smallint
  CHECK (guest_scroll_percent BETWEEN 50 AND 100);

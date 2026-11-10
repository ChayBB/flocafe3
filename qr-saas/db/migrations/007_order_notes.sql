ALTER TABLE orders ADD COLUMN note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200);

-- When the subject was last read or Done here. Backfill leaves it null, so a thread it
-- dismissed that is still unread on GitHub keeps showing unread.
ALTER TABLE item_state ADD COLUMN read_at TEXT;

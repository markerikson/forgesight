-- item state for Done, snooze wake conditions, and undo
ALTER TABLE item_state ADD COLUMN done_at TEXT;
ALTER TABLE item_state ADD COLUMN snoozed_at TEXT;
ALTER TABLE item_state ADD COLUMN snooze_until_ready INTEGER NOT NULL DEFAULT 0;

-- every state op from the web, with the item states it replaced (for undo)
CREATE TABLE state_ops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  op_json     TEXT NOT NULL,            -- StateOp
  prev_json   TEXT NOT NULL,            -- { [subjectKey]: ItemState } before the op
  undone_at   TEXT
);

-- GitHub writes waiting to be sent by the worker
CREATE TABLE outbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  state_op_id   INTEGER NOT NULL REFERENCES state_ops(id),
  op            TEXT NOT NULL,          -- done | read | unsubscribe | resubscribe
  thread_id     TEXT NOT NULL,
  subject_key   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  run_after     TEXT NOT NULL,          -- created_at + 10s; pushed out on retry
  claimed_at    TEXT,                   -- set by the drainer just before the GitHub call
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  completed_at  TEXT,
  failed_at     TEXT                    -- gave up after MAX_ATTEMPTS
);
CREATE INDEX outbox_pending ON outbox (run_after) WHERE completed_at IS NULL AND failed_at IS NULL;
CREATE INDEX outbox_op ON outbox (state_op_id);

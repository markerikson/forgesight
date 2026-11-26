CREATE TABLE push_verdicts (
  push_node_id TEXT PRIMARY KEY,
  subject_key TEXT NOT NULL,
  before_sha TEXT NOT NULL,
  after_sha TEXT NOT NULL,
  base_before TEXT,
  base_after TEXT,
  verdict TEXT NOT NULL, -- pending | rebase_only | noop | changed | unknown
  reason TEXT,
  method TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE INDEX push_verdicts_subject ON push_verdicts(subject_key);
CREATE INDEX push_verdicts_pending ON push_verdicts(verdict, next_attempt_at);

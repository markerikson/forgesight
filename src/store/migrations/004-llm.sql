-- LLM work. Subject keys are plain text, no foreign keys. Also extends 003's pr_texts.

-- queued model calls; one live job per (kind, subject_key)
CREATE TABLE llm_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,          -- workstream
  subject_key     TEXT NOT NULL,          -- workstream id for kind = workstream
  input_hash      TEXT NOT NULL,
  request_json    TEXT NOT NULL,          -- SummaryRequest plus model
  status          TEXT NOT NULL,          -- queued | running | done | failed | superseded
  attempts        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  run_after       TEXT NOT NULL,          -- pushed out on retry
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX llm_jobs_pending ON llm_jobs (run_after) WHERE status = 'queued';
CREATE INDEX llm_jobs_subject ON llm_jobs (kind, subject_key);

-- every provider call, successful or not, for cost tracking and the daily cap
CREATE TABLE llm_calls (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id              INTEGER,
  kind                TEXT NOT NULL,
  model               TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL NOT NULL DEFAULT 0,
  duration_ms         INTEGER,
  ok                  INTEGER NOT NULL,
  error               TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX llm_calls_created ON llm_calls (created_at);

-- generated text, cached by input hash
CREATE TABLE summaries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,          -- workstream (v1); pr later
  subject_key     TEXT NOT NULL,
  input_hash      TEXT NOT NULL,
  prompt_version  INTEGER NOT NULL,
  model           TEXT NOT NULL,
  name            TEXT,                   -- suggested workstream name
  text            TEXT NOT NULL,
  status          TEXT,                   -- status line when closed or tabled
  output_json     TEXT NOT NULL,
  cost_usd        REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  UNIQUE (kind, subject_key, input_hash)
);
CREATE INDEX summaries_latest ON summaries (kind, subject_key, created_at);

-- PR state as of the text fetch, for members no longer in the open PR listing
ALTER TABLE pr_texts ADD COLUMN state TEXT;                       -- OPEN | CLOSED | MERGED
ALTER TABLE pr_texts ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0;

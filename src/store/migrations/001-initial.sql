-- All timestamps are ISO 8601 UTC strings, so string comparison sorts correctly.

-- key/value worker state: etags, poll times, adaptive batch sizes, derive cursor
CREATE TABLE meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- notification threads, one row per GitHub thread id
CREATE TABLE threads (
  thread_id     TEXT PRIMARY KEY,
  subject_key   TEXT NOT NULL,          -- owner/repo#N or owner/repo@thread_id
  repo          TEXT NOT NULL,          -- owner/repo
  subject_type  TEXT NOT NULL,          -- PullRequest | Issue | Release | Discussion | CheckSuite ...
  reason        TEXT NOT NULL,
  unread        INTEGER NOT NULL,
  updated_at    TEXT NOT NULL,
  last_read_at  TEXT,
  first_seen_at TEXT NOT NULL,
  gh_done_at    TEXT,                   -- set when our outbox marked it done
  subject_url   TEXT,
  raw_json      TEXT NOT NULL
);
CREATE INDEX threads_subject ON threads(subject_key);
CREATE INDEX threads_updated ON threads(updated_at);

-- one row per PR / issue we track (from a thread, a stack, or open-PR listing)
CREATE TABLE subjects (
  subject_key           TEXT PRIMARY KEY,
  repo                  TEXT NOT NULL,
  number                INTEGER,
  kind                  TEXT NOT NULL,  -- pr | issue | other
  node_id               TEXT,
  origin                TEXT NOT NULL,  -- thread | stack | open-list
  state                 TEXT,           -- OPEN | CLOSED | MERGED
  author                TEXT,
  head_ref              TEXT,
  base_ref              TEXT,
  head_sha              TEXT,
  base_sha              TEXT,
  updated_at            TEXT,
  timeline_synced_until TEXT,
  dirty_at              TEXT,           -- non-null = needs enrichment
  priority              INTEGER NOT NULL DEFAULT 0,
  enrich_error          TEXT,
  enrich_attempts       INTEGER NOT NULL DEFAULT 0,
  raw_json              TEXT            -- last PrCore payload
);
CREATE INDEX subjects_dirty ON subjects(repo, priority DESC, dirty_at) WHERE dirty_at IS NOT NULL;

-- raw timeline items, append-only, deduped by GraphQL node id
CREATE TABLE timeline_items (
  node_id     TEXT PRIMARY KEY,
  subject_key TEXT NOT NULL,
  typename    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  raw_json    TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);
CREATE INDEX timeline_subject ON timeline_items(subject_key, created_at);

CREATE TABLE review_threads (
  node_id     TEXT PRIMARY KEY,
  subject_key TEXT NOT NULL,
  is_resolved INTEGER NOT NULL,
  is_outdated INTEGER NOT NULL,
  path        TEXT,
  line        INTEGER,
  raw_json    TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);
CREATE INDEX review_threads_subject ON review_threads(subject_key);

-- every distinct version of a sticky bot comment (DiffLoupe, replay-qa ...)
CREATE TABLE sticky_versions (
  comment_node_id TEXT NOT NULL,
  body_hash       TEXT NOT NULL,
  subject_key     TEXT NOT NULL,
  author          TEXT NOT NULL,
  last_edited_at  TEXT,
  seen_at         TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  body            TEXT NOT NULL,
  PRIMARY KEY (comment_node_id, body_hash)
);
CREATE INDEX sticky_versions_subject ON sticky_versions(subject_key, last_seen_at);

-- user state (web writes; the poller seeds dismissed_at during backfill)
CREATE TABLE item_state (
  subject_key              TEXT PRIMARY KEY,
  dismissed_at             TEXT,
  keep_unread              INTEGER NOT NULL DEFAULT 0,
  snooze_until             TEXT,
  snooze_until_human_event INTEGER NOT NULL DEFAULT 0,
  muted                    INTEGER NOT NULL DEFAULT 0,
  updated_at               TEXT NOT NULL
);

-- derived (rebuildable)
CREATE TABLE subject_views (
  subject_key      TEXT PRIMARY KEY,
  pipeline_version INTEGER NOT NULL,
  config_hash      TEXT NOT NULL,
  section          TEXT NOT NULL,       -- waiting | updates | hidden ...
  sort_at          TEXT NOT NULL,       -- latest meaningful event
  score            REAL NOT NULL,
  repo             TEXT NOT NULL,
  stack_id         TEXT,
  row_json         TEXT NOT NULL,       -- list row
  detail_json      TEXT NOT NULL,       -- rounds, events, findings, links for the preview
  computed_at      TEXT NOT NULL
);
CREATE INDEX subject_views_section ON subject_views(section, sort_at DESC);

-- change feed for derive (raw) and SSE (view, state, status)
CREATE TABLE changes (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- raw | view | state | status
  subject_key TEXT
);
CREATE INDEX changes_at ON changes(at);

-- observability
CREATE TABLE api_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  resource    TEXT NOT NULL,
  work_class  TEXT NOT NULL,
  request     TEXT NOT NULL,
  status      INTEGER,
  cost        INTEGER,
  remaining   INTEGER,
  reset_at    TEXT,
  duration_ms INTEGER
);
CREATE INDEX api_calls_at ON api_calls(at);

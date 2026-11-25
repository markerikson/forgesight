-- groups of related open PRs (stacks, shared bases, manual merges) in overview repos
CREATE TABLE workstreams (
  id            TEXT PRIMARY KEY,       -- <repo>:ws:<number>, stable across rebuilds
  repo          TEXT NOT NULL,
  name          TEXT NOT NULL,          -- detected name
  name_source   TEXT NOT NULL,          -- config | prefix | title | manual (of the detected name)
  manual_name   TEXT,                   -- set by rename; wins over name
  signals_json  TEXT NOT NULL,          -- WsSignal[]
  author        TEXT NOT NULL,          -- most common member author
  prefix        TEXT,                   -- shared title prefix, for matching a reopened stack
  closed        INTEGER NOT NULL DEFAULT 0,
  closed_at     TEXT,
  archived      INTEGER NOT NULL DEFAULT 0, -- 1: closed and gone from the listing; no members,
                                            -- kept 14 days so a reopened stack gets its ID back
  first_seen_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX workstreams_repo ON workstreams (repo);

CREATE TABLE workstream_members (
  workstream_id TEXT NOT NULL,
  subject_key   TEXT NOT NULL,
  position      INTEGER NOT NULL,       -- stack order
  parent_key    TEXT,
  listing_only  INTEGER NOT NULL,       -- 1: no subjects row (workstream has no list row)
  PRIMARY KEY (workstream_id, subject_key)
);
CREATE INDEX workstream_members_subject ON workstream_members (subject_key);

-- manual edits replayed on every rebuild
CREATE TABLE workstream_overrides (
  id           INTEGER PRIMARY KEY,
  repo         TEXT NOT NULL,
  kind         TEXT NOT NULL,           -- merge | remove | rename
  payload_json TEXT NOT NULL,           -- WsOverride
  created_at   TEXT NOT NULL
);
CREATE INDEX workstream_overrides_repo ON workstream_overrides (repo);

CREATE TABLE workstream_state (
  workstream_id            TEXT PRIMARY KEY,
  priority                 TEXT NOT NULL DEFAULT 'normal',  -- normal | low | muted
  seen_at                  TEXT,
  seen_summary_hash        TEXT,
  snooze_until             TEXT,
  snooze_until_human_event INTEGER NOT NULL DEFAULT 0,
  snooze_until_ready       INTEGER NOT NULL DEFAULT 0,
  snoozed_at               TEXT,
  updated_at               TEXT NOT NULL
);

-- PR descriptions for workstream summaries
CREATE TABLE pr_texts (
  repo       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,             -- bodyText, truncated
  updated_at TEXT NOT NULL,             -- PR updatedAt when fetched
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

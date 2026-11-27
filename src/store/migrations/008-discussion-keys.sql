-- Discussions move from owner/repo@thread_id keys to owner/repo#N keys with kind 'discussion'.
CREATE TEMP TABLE discussion_keys AS
SELECT DISTINCT
  subject_key AS old_key,
  repo || '#' || CAST(substr(subject_url, instr(subject_url, '/discussions/') + 13) AS INTEGER) AS new_key,
  repo,
  CAST(substr(subject_url, instr(subject_url, '/discussions/') + 13) AS INTEGER) AS number
FROM threads
WHERE subject_type = 'Discussion'
  AND subject_key LIKE '%@%'
  AND subject_url LIKE 'https://api.github.com/repos/%/discussions/%';

UPDATE threads
SET subject_key = (SELECT new_key FROM discussion_keys WHERE old_key = threads.subject_key)
WHERE subject_key IN (SELECT old_key FROM discussion_keys);

-- Several old keys can share one discussion; keep one subject row per new key.
INSERT OR IGNORE INTO subjects (subject_key, repo, number, kind, origin, dirty_at, priority)
SELECT k.new_key, k.repo, k.number, 'discussion', s.origin, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), s.priority
FROM discussion_keys k
JOIN subjects s ON s.subject_key = k.old_key;
DELETE FROM subjects WHERE subject_key IN (SELECT old_key FROM discussion_keys);

UPDATE OR IGNORE item_state
SET subject_key = (SELECT new_key FROM discussion_keys WHERE old_key = item_state.subject_key)
WHERE subject_key IN (SELECT old_key FROM discussion_keys);
DELETE FROM item_state WHERE subject_key IN (SELECT old_key FROM discussion_keys);

UPDATE OR IGNORE workstream_members
SET subject_key = (SELECT new_key FROM discussion_keys WHERE old_key = workstream_members.subject_key)
WHERE subject_key IN (SELECT old_key FROM discussion_keys);
DELETE FROM workstream_members WHERE subject_key IN (SELECT old_key FROM discussion_keys);

UPDATE outbox
SET subject_key = (SELECT new_key FROM discussion_keys WHERE old_key = outbox.subject_key)
WHERE subject_key IN (SELECT old_key FROM discussion_keys);

DELETE FROM timeline_items WHERE subject_key IN (SELECT old_key FROM discussion_keys);
DELETE FROM subject_views WHERE subject_key IN (SELECT old_key FROM discussion_keys);

INSERT INTO changes (at, kind, subject_key)
SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'raw', new_key FROM (SELECT DISTINCT new_key FROM discussion_keys);

DROP TABLE discussion_keys;

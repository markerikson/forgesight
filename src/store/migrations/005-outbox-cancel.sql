-- a reversing op (keep unread, unmute, unsubscribe) cancels the opposite write still waiting
-- in the outbox; undoing that op revives the row
ALTER TABLE outbox ADD COLUMN cancelled_by INTEGER REFERENCES state_ops(id);

-- When a beer was first rated (not touched by later edits). Used to break ties on the
-- "consumed" board: whoever reached a count first ranks higher.
ALTER TABLE ratings ADD COLUMN created_at TEXT;

-- Backfill: the latest 'rated' event for the cell (a clear + re-rate starts over), else updated_at.
UPDATE ratings SET created_at = COALESCE(
  (SELECT MAX(e.created_at) FROM events e
    WHERE e.beer_id = ratings.beer_id AND e.user_id = ratings.user_id AND e.type = 'rated'),
  updated_at
);

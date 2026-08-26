-- Departures settled by re-asking rows we had already written off, rather than
-- by a live sweep noticing them within days.
--
-- Both are genuine 404s. They are not equally good evidence about WHEN: the
-- re-verification pass ran weeks after the fact and keeps the original
-- removed_at, which is the best estimate available and still an estimate. Kept
-- as its own count so the read side can drop them from week-over-week
-- comparisons instead of relying on someone remembering the difference.
ALTER TABLE model_flow_weekly
  ADD COLUMN IF NOT EXISTS disappeared_backfilled integer NOT NULL DEFAULT 0;

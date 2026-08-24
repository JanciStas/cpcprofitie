-- Where a cron-driven backfill got to.
--
-- Every backfill under app/api/admin walks the listings table by id and hands
-- `nextCursor` back to whoever called it. A shell script in a loop can pass it
-- back; a cron cannot, because it fires the same URL every time. With nowhere
-- to keep the cursor, each run repeats the first batch for ever.
--
-- That is why none of the seven tools under app/api/admin was ever put in
-- vercel.json, and why missing years, mileages and model ids only ever got
-- filled in when a person sat and drove the loop by hand.
--
-- A cursor is needed rather than a plain "WHERE field IS NULL" because rows
-- that stay NULL after a successful pass -- a title that resolves to no model,
-- an advert with no year printed anywhere -- sit at the head of the set
-- permanently and would be re-fetched on every single run.
CREATE TABLE IF NOT EXISTS job_cursors (
  job_key    varchar(64) PRIMARY KEY,
  -- Highest id processed. NULL means "start from the beginning": both on the
  -- first run and after the walk wraps.
  after_id   bigint,
  -- Bumped each time the set is exhausted and the cursor resets to the top, so
  -- a stalled job is visible as a pass number that never moves.
  pass_no    integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

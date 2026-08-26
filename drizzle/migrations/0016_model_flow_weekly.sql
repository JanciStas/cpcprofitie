-- Weekly flow per model: how much listing-time we observed, and how much of it
-- ended in the listing leaving the market.
--
-- WHY NOT COLUMNS ON market_snapshots, which is the obvious place:
--
--  * That table measures a STOCK at an instant and is keyed by a single
--    captured_on. These are quantities over an INTERVAL and need both edges;
--    sharing the key invites someone to sum them across weeks whose exposure
--    does not match.
--  * Its grain is (model, region, year bucket, mileage bucket) and its cells
--    are already thin enough that region had to be collapsed to 'all'. This
--    needs whole-model grain plus a `source` stratum, and adding source to that
--    key would fragment the price cohorts a second time.
--  * Its population requires a plausible price, a year AND a mileage. A car
--    with no recorded mileage still disappears. Different question, different
--    WHERE clause.
--  * Its rows are treated as immutable measurements of a finished week; the
--    in-progress week here is legitimately rewritten every day.
--
-- WHY COUNTS AND EXPOSURE, NEVER A RATE. The global rate and the shrinkage
-- constant both move as data accumulates, so a stored rate would freeze a
-- week-one prior in place for ever and weeks could not be pooled by addition.
-- market_snapshots.count_sold is a numerator with no denominator; that column
-- is the exact shape of the metric that had to be pulled from the UI, and it
-- should not gain siblings.

CREATE TABLE IF NOT EXISTS model_flow_weekly (
  model_id      integer     NOT NULL REFERENCES vehicle_models(id) ON DELETE CASCADE,
  -- A stratum, never 'all'. Private bazos.sk adverts turn over on a different
  -- clock from dealer stock on autobazar; a pooled rate would rank the sources
  -- and call the result demand.
  source        varchar(32) NOT NULL,
  window_start  timestamptz NOT NULL,
  window_end    timestamptz NOT NULL,

  -- THE DENOMINATOR. Time each listing was observed at risk, in listing-days.
  -- Closes at the last moment we confirmed the listing, not at the window edge,
  -- so a gap in our own crawling shrinks the denominator instead of being
  -- recorded as a car that stayed on the market.
  exposure_listing_days     numeric(12,2) NOT NULL,
  listings_observed         integer NOT NULL,
  disappeared               integer NOT NULL,
  -- The subset we actually saw 404. Small by design -- the HEAD sweep reaches
  -- roughly a thirteenth of the corpus a day -- and its job is to measure how
  -- often the cheaper absence signal is right.
  disappeared_confirmed_404 integer NOT NULL,
  -- Delete-and-relist is a disappearance followed by a reappearance. Only
  -- detectable where a fingerprint exists, which on bazos.sk is 15% of rows;
  -- the caveat in the UI has to say so.
  reappeared_within_30d     integer NOT NULL DEFAULT 0,

  -- Price movement carries its own exposure: time between two prices we
  -- actually read. A listing priced once this week contributes nothing,
  -- because scoring it "did not cut" is the same error as scoring an unchecked
  -- listing "still for sale".
  price_obs_exposure_listing_days numeric(12,2) NOT NULL DEFAULT 0,
  price_cuts                integer NOT NULL DEFAULT 0,
  price_raises              integer NOT NULL DEFAULT 0,
  cut_depth_pct_median      numeric(5,2),

  -- True when the liveness instrument produced at least one result for this
  -- source in this window. Without it, a source nobody checked and a source
  -- where nothing left are the same row of zeroes, and only one of those is a
  -- measurement. (An earlier draft gated on the catalogue sweep instead. That
  -- was abandoned when absence-from-sweep was measured at zero precision --
  -- see the header of lib/analytics/liquidity.ts.)
  sweep_complete            boolean NOT NULL DEFAULT false,
  computed_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, source, window_start)
);

CREATE INDEX IF NOT EXISTS model_flow_weekly_window_idx
  ON model_flow_weekly (window_start, model_id);

-- Supports the per-source exposure walk.
CREATE INDEX IF NOT EXISTS listings_source_last_seen_idx
  ON listings (source, last_seen_at)
  WHERE canonical_listing_id IS NULL;

// Measures, per model per source per week, how much listing-time we observed
// and how much of it ended in a CONFIRMED departure.
//
// ── WHAT COUNTS AS A DEPARTURE, AND THE THING THAT ALMOST SHIPPED ───────────
//
// The cheap signal is absence: the scraper walks the whole page space, so a
// listing that stops appearing in a completed sweep has presumably left. It
// covers every source at no extra crawl cost, where confirmed 404s are limited
// by how fast the HEAD sweep can go. It is also worthless, and this is measured,
// not argued:
//
//   90 listings that the absence rule called gone were sampled at random and
//   asked directly. 35 were probed across all three hosts. 35 came back alive.
//   Precision: ZERO.
//
// The reason is structural and already documented elsewhere in this repo: the
// page space does not enumerate the catalogue. autobazar.sk caps around 700
// pages, autobazar.eu indexes a fixed list modulo its length, and bazos.sk's
// depth ceiling reaches about 29% of the source. A listing missing from the
// pages we walked is the normal case, not evidence of anything. Applied to the
// corpus the rule produced 20 234 departures a week on bazos.sk alone — a 328%
// weekly turnover — which is the same "we measured our own latency and called
// it the market" error that cost this project its first sales metric.
//
// So: only confirmed departures count. An HTTP 404 or 410 we actually saw,
// from the HEAD sweep or from an enrichment fetch. Fewer events, all of them
// real, and the estimator below is built to work with exactly that.
//
// ── WHY THE UNDERCOUNT IS SURVIVABLE AND THE OVERCOUNT WAS NOT ──────────────
//
// The HEAD sweep reaches roughly a thirteenth of the corpus a day, so a
// departure is noticed days after it happens. That biases WHEN, and in short
// windows it biases the count downward, because deaths near the window edge are
// confirmed after it. It does not invent departures. Pooling four weeks or more
// and treating the newest week as provisional handles it; nothing handles a
// signal whose errors all point the same way and are 100% of its output.
//
// ── LEGACY ROWS ARE EXCLUDED ───────────────────────────────────────────────
//
// Until 2026-08-26 the enrichment path wrote removed_at on HTTP 403 as well —
// "the source is blocking us" recorded as "the car is gone" — and its tombstone
// said only '[GONE]', so those rows cannot be told apart after the fact. Every
// tombstone written since carries its reason ('[GONE:404]'). A bare '[GONE]' is
// therefore treated as no evidence at all.

import { sql } from 'drizzle-orm';
import * as Sentry from '@sentry/nextjs';
import { getDb } from '@/lib/db';
import { isConnectionError, noteDbUnavailable } from '@/lib/db/errors';

export type FlowStats = {
  windowStart: string;
  windowEnd: string;
  rowsWritten: number;
  events: number;
  exposureListingDays: number;
  errors: number;
};

/** ISO week containing `asOf`, as [start, end). Monday 00:00 UTC boundaries. */
export function isoWeekBounds(asOf: Date): { start: Date; end: Date } {
  const d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  // getUTCDay: 0=Sun. Shift so Monday is 0.
  const shift = (d.getUTCDay() + 6) % 7;
  const start = new Date(d.getTime() - shift * 86_400_000);
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

/**
 * Compute and store one week of flow.
 *
 * Idempotent: the maintenance cron runs daily and rewrites the in-progress
 * week's rows, which is correct for an occurrence-exposure pair — both halves
 * accumulate together, so a partially filled week is internally consistent
 * rather than merely incomplete.
 */
export async function computeWeeklyFlow(opts: { asOf?: Date } = {}): Promise<FlowStats> {
  const db = getDb();
  const { start, end } = isoWeekBounds(opts.asOf ?? new Date());
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const stats: FlowStats = {
    windowStart: startIso,
    windowEnd: endIso,
    rowsWritten: 0,
    events: 0,
    exposureListingDays: 0,
    errors: 0,
  };

  try {
    // Drizzle refuses to bind a Date inside some SQL contexts, so the window
    // edges go in as inlined timestamptz literals. Same trap, same workaround
    // as computeWeeklySnapshots.
    const t0 = sql.raw(`'${startIso}'::timestamptz`);
    const t1 = sql.raw(`'${endIso}'::timestamptz`);

    const rows = (await db.execute(sql`
      WITH base AS (
        SELECT
          l.id, l.model_id, l.source, l.fingerprint, l.first_seen_at,
          l.first_seen_alive_at AS entered_at,
          -- A departure only when we have evidence of one. A bare '[GONE]'
          -- predates the reason being recorded and may be a 403.
          CASE
            WHEN l.removed_at IS NULL THEN NULL
            WHEN d.description IS NULL THEN l.removed_at          -- HEAD sweep
            WHEN d.description LIKE '[GONE:%' THEN l.removed_at   -- reason known
            ELSE NULL
          END AS confirmed_gone_at
        FROM listings l
        LEFT JOIN listing_details d ON d.listing_id = l.id
        WHERE l.model_id IS NOT NULL
          AND l.canonical_listing_id IS NULL
          AND l.is_vehicle
          -- No price/year/mileage gate, unlike market_snapshots: a car with no
          -- recorded mileage still leaves the market. Different question.
          AND l.first_seen_alive_at IS NOT NULL
          AND l.first_seen_alive_at < ${t1}
      ),
      ev AS (
        SELECT b.*,
          -- Exposure closes at the departure, or at the window edge for a
          -- listing still on sale. Censoring, not survival: a car still listed
          -- contributes time and no event.
          LEAST(${t1}, COALESCE(b.confirmed_gone_at, ${t1})) AS exit_at,
          GREATEST(${t0}, b.entered_at) AS enter_at
        FROM base b
      ),
      scored AS (
        SELECT ev.*,
          GREATEST(0, EXTRACT(EPOCH FROM (exit_at - enter_at)) / 86400.0) AS days,
          (confirmed_gone_at >= ${t0} AND confirmed_gone_at < ${t1}) AS died_here
        FROM ev
      )
      SELECT
        s.model_id,
        s.source,
        SUM(s.days)::numeric(12,2) AS exposure_listing_days,
        COUNT(*) FILTER (WHERE s.days > 0)::int AS listings_observed,
        COUNT(*) FILTER (WHERE s.died_here)::int AS disappeared,
        COUNT(*) FILTER (WHERE s.died_here)::int AS disappeared_confirmed_404,
        -- Delete-and-relist is a departure followed by a return. Only visible
        -- where a fingerprint exists, which on bazos.sk is 15% of rows; the
        -- caveat in the UI has to say so rather than imply this is complete.
        COUNT(*) FILTER (
          WHERE s.died_here AND s.fingerprint IS NOT NULL AND EXISTS (
            SELECT 1 FROM listings r
            WHERE r.fingerprint = s.fingerprint
              AND r.id <> s.id
              AND r.source = s.source
              AND r.first_seen_at > s.first_seen_at
              AND r.first_seen_at BETWEEN (s.confirmed_gone_at - interval '30 days')
                                      AND (s.confirmed_gone_at + interval '30 days')
          )
        )::int AS reappeared_within_30d
      FROM scored s
      GROUP BY s.model_id, s.source
      HAVING SUM(s.days) > 0
    `)) as unknown as Array<{
      model_id: number;
      source: string;
      exposure_listing_days: string;
      listings_observed: number;
      disappeared: number;
      disappeared_confirmed_404: number;
      reappeared_within_30d: number;
    }>;

    if (rows.length === 0) return stats;

    // sweep_complete is stored per row but means something narrower than its
    // name once departures are confirmed-only: it records that the HEAD sweep
    // was running for this source in this window, i.e. that a zero here is a
    // measurement rather than an absence of instrument.
    const swept = (await db.execute(sql`
      SELECT source, COUNT(*)::int AS n
      FROM listings
      WHERE removed_at >= ${t0} AND removed_at < ${t1}
      GROUP BY source
    `)) as unknown as Array<{ source: string; n: number }>;
    const sweptSources = new Set(swept.filter((r) => r.n > 0).map((r) => r.source));

    const values = rows.map(
      (r) => sql`(
        ${r.model_id}, ${r.source}, ${t0}, ${t1},
        ${r.exposure_listing_days}::numeric, ${r.listings_observed},
        ${r.disappeared}, ${r.disappeared_confirmed_404}, ${r.reappeared_within_30d},
        ${sweptSources.has(r.source)}
      )`,
    );

    await db.execute(sql`
      INSERT INTO model_flow_weekly (
        model_id, source, window_start, window_end,
        exposure_listing_days, listings_observed,
        disappeared, disappeared_confirmed_404, reappeared_within_30d, sweep_complete
      ) VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (model_id, source, window_start) DO UPDATE SET
        window_end = excluded.window_end,
        exposure_listing_days = excluded.exposure_listing_days,
        listings_observed = excluded.listings_observed,
        disappeared = excluded.disappeared,
        disappeared_confirmed_404 = excluded.disappeared_confirmed_404,
        reappeared_within_30d = excluded.reappeared_within_30d,
        sweep_complete = excluded.sweep_complete,
        computed_at = now()
    `);

    stats.rowsWritten = rows.length;
    stats.events = rows.reduce((a, r) => a + r.disappeared, 0);
    stats.exposureListingDays = rows.reduce((a, r) => a + Number(r.exposure_listing_days), 0);
  } catch (e) {
    if (isConnectionError(e)) throw noteDbUnavailable(e, { step: 'liquidity.computeWeeklyFlow' });
    stats.errors++;
    Sentry.captureException(e, { tags: { component: 'liquidity', step: 'computeWeeklyFlow' } });
  }

  return stats;
}

/**
 * Price movement for the same week, folded into the rows the flow pass wrote.
 *
 * Kept as a second statement rather than one giant query because it draws on a
 * different table with a different shape of gap, and because a failure in one
 * should not cost the other.
 */
export async function computeWeeklyPriceFlow(opts: { asOf?: Date } = {}): Promise<number> {
  const db = getDb();
  const { start, end } = isoWeekBounds(opts.asOf ?? new Date());
  const d0 = sql.raw(`'${start.toISOString().slice(0, 10)}'::date`);
  const d1 = sql.raw(`'${end.toISOString().slice(0, 10)}'::date`);

  const rows = (await db.execute(sql`
    WITH obs AS (
      SELECT listing_id, recorded_on, price_eur::float8 AS p,
             LAG(price_eur::float8) OVER w AS prev_p,
             LAG(recorded_on) OVER w AS prev_on
      FROM listing_price_history
      -- Reach back before the window so the first in-window reading has a
      -- predecessor to be compared with.
      WHERE recorded_on BETWEEN ${d0} - 21 AND ${d1}
      WINDOW w AS (PARTITION BY listing_id ORDER BY recorded_on)
    ),
    steps AS (
      SELECT o.listing_id,
             (o.recorded_on - o.prev_on)::float8 AS gap_days,
             (o.p - o.prev_p) / NULLIF(o.prev_p, 0) AS rel,
             (o.p - o.prev_p) AS abs_delta
      FROM obs o
      WHERE o.prev_p IS NOT NULL
        AND o.recorded_on >= ${d0}
        -- A gap this wide is not one price change, it is an unknown number of
        -- them, and its depth cannot be attributed to a single decision.
        AND (o.recorded_on - o.prev_on) <= 21
    )
    SELECT l.model_id, l.source,
      SUM(s.gap_days)::numeric(12,2) AS price_obs_exposure_listing_days,
      -- The floors kill rounding and re-parse noise: a 0.4% wobble on a 12 000
      -- EUR car is not a price cut, it is the same price read twice.
      COUNT(*) FILTER (WHERE s.rel <= -0.01 AND s.abs_delta <= -50)::int AS price_cuts,
      COUNT(*) FILTER (WHERE s.rel >= 0.01 AND s.abs_delta >= 50)::int AS price_raises,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY -s.rel * 100)
        FILTER (WHERE s.rel <= -0.01 AND s.abs_delta <= -50) AS cut_depth_pct_median
    FROM steps s
    JOIN listings l ON l.id = s.listing_id
    WHERE l.canonical_listing_id IS NULL AND l.is_vehicle AND l.model_id IS NOT NULL
    GROUP BY l.model_id, l.source
  `)) as unknown as Array<{
    model_id: number;
    source: string;
    price_obs_exposure_listing_days: string;
    price_cuts: number;
    price_raises: number;
    cut_depth_pct_median: string | null;
  }>;

  if (rows.length === 0) return 0;

  const t0 = sql.raw(`'${start.toISOString()}'::timestamptz`);
  let updated = 0;
  // Only rows the flow pass already created are updated: price movement without
  // exposure has no denominator to sit beside.
  for (const r of rows) {
    const res = await db.execute(sql`
      UPDATE model_flow_weekly SET
        price_obs_exposure_listing_days = ${r.price_obs_exposure_listing_days}::numeric,
        price_cuts = ${r.price_cuts},
        price_raises = ${r.price_raises},
        cut_depth_pct_median = ${r.cut_depth_pct_median}
      WHERE model_id = ${r.model_id} AND source = ${r.source} AND window_start = ${t0}
      RETURNING model_id
    `);
    updated += (res as unknown as unknown[]).length;
  }
  return updated;
}

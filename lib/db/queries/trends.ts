// Query helpers for /app/trends and /app/deals pages. Read-only — no writes.

import * as Sentry from '@sentry/nextjs';
import { sql } from 'drizzle-orm';
import { getDb } from '../index';
import { marketReferenceRaw } from '@/lib/analytics/quality';

export type TrendRow = {
  modelId: number;
  makeSlug: string;
  modelSlug: string;
  modelName: string;
  countActive: number;
  countActiveLastWeek: number;
  countSoldThisWeek: number;
  medianPriceEur: number | null;
  medianLastWeekEur: number | null;
  daysToSellAvg: number | null;
};

export type DealRow = {
  listingId: bigint;
  source: string;
  url: string;
  makeName: string | null;
  modelName: string | null;
  year: number | null;
  mileageKm: number | null;
  region: string | null;
  priceEur: number;
  marketMedianEur: number;
  marketP25Eur: number;
  discountPct: number;
  potentialGainEur: number;
  cohortSize: number;
  confidence: 'low' | 'medium' | 'high';
  heroPhotoUrl: string | null;
};

/**
 * Cars needed before a model-level median is worth showing.
 *
 * 1 351 of 2 250 models have fewer than five priced listings. Publishing a
 * "median" for those was publishing one car's asking price under a word that
 * promises a market.
 */
export const MIN_MODELS_FOR_MEDIAN = 5;

// 'movement' (rank by sales) is gone: 93% of recorded sales were listings
// already dead the first time we fetched them, so it ordered by a column that
// is now almost entirely zero.
export type TrendsSort = 'demand' | 'price-drop';

/**
 * Top N models by demand metric. Joins this-week and last-week snapshots so
 * the UI can render WoW arrows. Falls back to live counts when snapshots
 * haven't been computed yet (first deploy).
 */
/**
 * Week-over-week comparisons reaching back before this date are not rendered.
 *
 * market_snapshots holds a measurement of a week that cannot be recomputed, so
 * a comparison is only honest when both sides describe the same corpus. Between
 * 2026-08-17 and 2026-08-24 the corpus grew by roughly a third — the scraper
 * started walking the whole autobazar.sk catalogue instead of 35 brands, and
 * bazos.sk finished a deep cycle. A week-on-week arrow across that boundary
 * would report a market that moved, when what moved was our coverage.
 *
 * Delete this once the earliest snapshot is later than the date: it is a scar
 * from one week, not a permanent rule.
 */
const WOW_COMPARABLE_FROM = '2026-08-24';

export async function getTrendingModels(opts: {
  limit?: number;
  sort?: TrendsSort;
} = {}): Promise<TrendRow[]> {
  try {
    return await getTrendingModelsUnsafe(opts);
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'trends', step: 'getTrendingModels' } });
    return [];
  }
}

async function getTrendingModelsUnsafe(opts: {
  limit?: number;
  sort?: TrendsSort;
}): Promise<TrendRow[]> {
  const limit = opts.limit ?? 20;
  const sort = opts.sort ?? 'demand';
  const db = getDb();

  // Aggregate snapshots across all (year, mileage) buckets per model so the
  // overview table shows whole-model totals. Drill-down page splits buckets.
  const rows = (await db.execute(sql`
    WITH this_week AS (
      SELECT
        model_id,
        SUM(count_active) AS count_active,
        SUM(count_sold) AS count_sold,
        -- Weighted by cohort size. A flat AVG gave a model's 40-car bucket and
        -- its 3-car bucket equal say, so the published "median" moved when the
        -- mix of buckets changed rather than when prices did.
        (SUM(median_price_eur::float8 * count_active) / NULLIF(SUM(count_active), 0))
          AS median_price,
        AVG(days_to_sell_avg::float8) AS days_to_sell
      FROM market_snapshots
      WHERE period = 'week'
        AND captured_on = (SELECT MAX(captured_on) FROM market_snapshots WHERE period = 'week')
        -- Filtered on read, not on write. A snapshot is a measurement of a
        -- past week and cannot be recomputed once those listings have moved,
        -- so raising the write floor would destroy rows permanently and still
        -- leave every row already published in place. Filtering here is
        -- reversible, applies to the whole history at once, and can be tuned
        -- without another week of data.
        AND count_active >= ${MIN_MODELS_FOR_MEDIAN}
      GROUP BY model_id
    ),
    last_week AS (
      SELECT
        model_id,
        SUM(count_active) AS count_active,
        AVG(median_price_eur::float8) AS median_price
      FROM market_snapshots
      WHERE period = 'week'
        AND captured_on = (
          SELECT MAX(captured_on) FROM market_snapshots
          WHERE period = 'week'
            AND captured_on < (SELECT MAX(captured_on) FROM market_snapshots WHERE period = 'week')
        )
      GROUP BY model_id
    ),
    -- Fallback for first deploy: count live canonical listings directly.
    -- Used for models with no snapshot yet — two thirds of them. It was an
    -- AVG with no plausibility bound, no parts filter and no minimum count,
    -- coalesced into the same column the UI labels "Medián ceny". So most of
    -- the page showed an unfiltered mean of one to four rows, called a median.
    live_fallback AS (
      SELECT
        l.model_id,
        COUNT(*) AS count_active,
        0::bigint AS count_sold,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY l.price_eur::float8) AS median_price,
        NULL::float8 AS days_to_sell
      FROM listings l
      WHERE l.model_id IS NOT NULL
        AND l.canonical_listing_id IS NULL
        AND l.sold_at IS NULL
        AND l.removed_at IS NULL
        AND ${marketReferenceRaw('l')}
      GROUP BY l.model_id
      -- Below this there is no market to speak of; the UI shows nothing rather
      -- than a number nobody could defend.
      HAVING COUNT(*) >= ${MIN_MODELS_FOR_MEDIAN}
    )
    SELECT
      vm.id AS model_id,
      vmk.slug AS make_slug,
      vm.slug AS model_slug,
      vm.name AS model_name,
      coalesce(tw.count_active, lf.count_active, 0)::int AS count_active,
      coalesce(lw.count_active, 0)::int AS count_active_last_week,
      coalesce(tw.count_sold, lf.count_sold, 0)::int AS count_sold_this_week,
      coalesce(tw.median_price, lf.median_price) AS median_price,
      lw.median_price AS median_last_week,
      coalesce(tw.days_to_sell, lf.days_to_sell) AS days_to_sell_avg
    FROM vehicle_models vm
    JOIN vehicle_makes vmk ON vmk.id = vm.make_id
    LEFT JOIN this_week tw ON tw.model_id = vm.id
    LEFT JOIN last_week lw ON lw.model_id = vm.id
    LEFT JOIN live_fallback lf ON lf.model_id = vm.id
    WHERE coalesce(tw.count_active, lf.count_active, 0) > 0
    ORDER BY
      CASE WHEN ${sort} = 'demand' THEN coalesce(tw.count_active, lf.count_active, 0) END DESC NULLS LAST,
      CASE WHEN ${sort} = 'price-drop'
        THEN (lw.median_price - coalesce(tw.median_price, lf.median_price))
      END DESC NULLS LAST
    LIMIT ${limit}
  `)) as unknown as Array<{
    model_id: number;
    make_slug: string;
    model_slug: string;
    model_name: string;
    count_active: number;
    count_active_last_week: number;
    count_sold_this_week: number;
    median_price: number | null;
    median_last_week: number | null;
    days_to_sell_avg: number | null;
  }>;

  // See WOW_COMPARABLE_FROM: a comparison that reaches back past a step change
  // in coverage describes our scraper, not the market.
  const prevRows = (await db.execute(sql`
    SELECT MAX(captured_on) AS captured_on FROM market_snapshots
    WHERE period = 'week'
      AND captured_on < (SELECT MAX(captured_on) FROM market_snapshots WHERE period = 'week')
  `)) as unknown as Array<{ captured_on: string | Date | null }>;
  const previousWeek = prevRows[0]?.captured_on ?? null;
  const comparable =
    previousWeek == null
      ? false
      : new Date(previousWeek).toISOString().slice(0, 10) >= WOW_COMPARABLE_FROM;

  return rows.map((r) => ({
    modelId: r.model_id,
    makeSlug: r.make_slug,
    modelSlug: r.model_slug,
    modelName: r.model_name,
    countActive: r.count_active,
    countActiveLastWeek: comparable ? r.count_active_last_week : 0,
    countSoldThisWeek: r.count_sold_this_week,
    medianPriceEur: r.median_price != null ? Math.round(r.median_price) : null,
    medianLastWeekEur:
      comparable && r.median_last_week != null ? Math.round(r.median_last_week) : null,
    daysToSellAvg: r.days_to_sell_avg,
  }));
}

export type DealFilters = {
  minConfidence?: 'low' | 'medium' | 'high';
  minDiscountPct?: number;
  minGainEur?: number;
  maxPriceEur?: number;
  modelId?: number;
  region?: string;
};

export type DealsSort = 'discount' | 'gain';

export async function getTopDeals(opts: {
  limit?: number;
  filters?: DealFilters;
  sort?: DealsSort;
} = {}): Promise<DealRow[]> {
  try {
    return await getTopDealsUnsafe(opts);
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'trends', step: 'getTopDeals' } });
    return [];
  }
}

async function getTopDealsUnsafe(opts: {
  limit?: number;
  filters?: DealFilters;
  sort?: DealsSort;
}): Promise<DealRow[]> {
  const limit = opts.limit ?? 50;
  const sort = opts.sort ?? 'discount';
  const f = opts.filters ?? {};
  const db = getDb();

  // Confidence is an ordered enum; filtering >= minConfidence is done in SQL
  // by mapping to a numeric weight.
  const minConfWeight =
    f.minConfidence === 'high' ? 3 : f.minConfidence === 'medium' ? 2 : 1;

  const rows = (await db.execute(sql`
    SELECT
      fo.listing_id,
      l.source,
      l.url,
      vmk.name AS make_name,
      vm.name AS model_name,
      l.year,
      l.mileage_km,
      l.region,
      l.price_eur::float8 AS price_eur,
      fo.market_median_eur::float8 AS market_median_eur,
      fo.market_p25_eur::float8 AS market_p25_eur,
      fo.discount_pct::float8 AS discount_pct,
      fo.potential_gain_eur::float8 AS potential_gain_eur,
      fo.cohort_size,
      fo.confidence,
      (
        SELECT url FROM listing_photos WHERE listing_id = l.id ORDER BY position ASC LIMIT 1
      ) AS hero_photo_url,
      CASE fo.confidence
        WHEN 'high' THEN 3
        WHEN 'medium' THEN 2
        ELSE 1
      END AS conf_weight
    FROM flip_opportunities fo
    JOIN listings l ON l.id = fo.listing_id
    LEFT JOIN vehicle_models vm ON vm.id = l.model_id
    LEFT JOIN vehicle_makes vmk ON vmk.id = vm.make_id
    WHERE l.sold_at IS NULL
      AND l.removed_at IS NULL
      AND l.canonical_listing_id IS NULL
      AND (
        CASE fo.confidence
          WHEN 'high' THEN 3
          WHEN 'medium' THEN 2
          ELSE 1
        END
      ) >= ${minConfWeight}
      ${f.minDiscountPct != null ? sql`AND fo.discount_pct >= ${f.minDiscountPct}` : sql``}
      ${f.minGainEur != null ? sql`AND fo.potential_gain_eur >= ${f.minGainEur}` : sql``}
      ${f.maxPriceEur != null ? sql`AND l.price_eur <= ${f.maxPriceEur}` : sql``}
      ${f.modelId != null ? sql`AND l.model_id = ${f.modelId}` : sql``}
      ${f.region != null ? sql`AND l.region = ${f.region}` : sql``}
    ORDER BY
      ${sort === 'gain' ? sql`fo.potential_gain_eur DESC` : sql`fo.discount_pct DESC`}
    LIMIT ${limit}
  `)) as unknown as Array<{
    listing_id: string | number | bigint;
    source: string;
    url: string;
    make_name: string | null;
    model_name: string | null;
    year: number | null;
    mileage_km: number | null;
    region: string | null;
    price_eur: number;
    market_median_eur: number;
    market_p25_eur: number;
    discount_pct: number;
    potential_gain_eur: number;
    cohort_size: number;
    confidence: 'low' | 'medium' | 'high';
    hero_photo_url: string | null;
  }>;

  return rows.map((r) => ({
    listingId: BigInt(r.listing_id as number),
    source: r.source,
    url: r.url,
    makeName: r.make_name,
    modelName: r.model_name,
    year: r.year,
    mileageKm: r.mileage_km,
    region: r.region,
    priceEur: Math.round(r.price_eur),
    marketMedianEur: Math.round(r.market_median_eur),
    marketP25Eur: Math.round(r.market_p25_eur),
    discountPct: Math.round(r.discount_pct * 10) / 10,
    potentialGainEur: Math.round(r.potential_gain_eur),
    cohortSize: r.cohort_size,
    confidence: r.confidence,
    heroPhotoUrl: r.hero_photo_url,
  }));
}

/** Per-week median price trajectory for a model — feeds the sparkline. */
export async function getModelTrajectory(
  modelId: number,
  opts: { weeks?: number } = {},
): Promise<Array<{ capturedOn: Date; medianPriceEur: number | null; countActive: number }>> {
  try {
    return await getModelTrajectoryUnsafe(modelId, opts);
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'trends', step: 'getModelTrajectory' } });
    return [];
  }
}

async function getModelTrajectoryUnsafe(
  modelId: number,
  opts: { weeks?: number },
): Promise<Array<{ capturedOn: Date; medianPriceEur: number | null; countActive: number }>> {
  const weeks = opts.weeks ?? 12;
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT
      captured_on,
      SUM(count_active)::int AS count_active,
      AVG(median_price_eur::float8) AS median_price
    FROM market_snapshots
    WHERE period = 'week'
      AND model_id = ${modelId}
      AND captured_on > now() - (${weeks}::int * interval '7 days')
    GROUP BY captured_on
    ORDER BY captured_on ASC
  `)) as unknown as Array<{
    captured_on: Date | string;
    count_active: number;
    median_price: number | null;
  }>;
  return rows.map((r) => ({
    capturedOn: new Date(r.captured_on),
    medianPriceEur: r.median_price != null ? Math.round(r.median_price) : null,
    countActive: r.count_active,
  }));
}

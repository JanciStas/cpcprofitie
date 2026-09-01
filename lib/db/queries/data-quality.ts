// Read-only data-quality metrics for the scraped listings corpus. Powers the
// admin data-quality page and the /api/admin/data-quality endpoint. No writes.
//
// The numbers here answer: how complete are the fields DealScore/market
// analytics depend on (model_id, price, year, mileage, seller_type), how much
// implausible data is poisoning cohorts, and per-source where it's worst.

import * as Sentry from '@sentry/nextjs';
import { unstable_cache } from 'next/cache';
import { sql } from 'drizzle-orm';
import { getDb } from '../index';
// Single source of truth for plausibility bounds — the same values the
// cohort/percentile queries filter on, so the "outlier" counts here match
// exactly what gets excluded downstream.
import { MILEAGE_MAX, PRICE_MAX, PRICE_MIN, YEAR_MIN } from '@/lib/analytics/quality';

export type SourceHealth = 'ok' | 'warn' | 'drift';

export type SourceCompleteness = {
  source: string;
  total: number;
  active: number;
  nullPricePct: number;
  nullYearPct: number;
  nullMileagePct: number;
  nullFuelPct: number;
  nullTransmissionPct: number;
  nullRegionPct: number;
  nullModelPct: number;
  /**
   * Share of active rows whose market we have not established.
   *
   * This is the gate for tightening the reference from "exclude what is known
   * foreign" to "admit only confirmed Slovak": flipping while this is high
   * would drop tens of thousands of rows we know nothing bad about. A measured
   * number rather than a guess about how far the rotation has got.
   */
  nullCountryPct: number;
  outlierPrice: number;
  outlierMileage: number;
  // Share of active listings carrying every field a DealScore cohort needs.
  cohortReadyPct: number;
  // Coarse health verdict for at-a-glance drift detection: a source whose
  // price or model coverage cratered almost always means a broken selector,
  // not a market shift. This is what would have flagged the autobazar.sk
  // 100%-null-price regression within a day instead of months.
  health: SourceHealth;
  healthReason: string | null;
};

// A price collapse is the strongest selector-drift signal (real markets never
// stop listing prices); model/region collapse is the next tier.
function assessHealth(c: {
  nullPricePct: number;
  nullModelPct: number;
  nullRegionPct: number;
}): { health: SourceHealth; healthReason: string | null } {
  if (c.nullPricePct >= 60) {
    return { health: 'drift', healthReason: `cena chýba ${c.nullPricePct}% — možný drift selektora` };
  }
  if (c.nullModelPct >= 70) {
    return { health: 'drift', healthReason: `model chýba ${c.nullModelPct}% — parser/enrichment` };
  }
  if (c.nullPricePct >= 30 || c.nullRegionPct >= 60 || c.nullModelPct >= 50) {
    return { health: 'warn', healthReason: 'zvýšená chýbovosť kľúčových polí' };
  }
  return { health: 'ok', healthReason: null };
}

/** Test seam — the health verdict is pure logic worth locking down. */
export const assessHealthForTest = assessHealth;

export type DriftAlert = { source: string; health: SourceHealth; reason: string };

/**
 * Pick the sources worth alerting on from a report — anything not `ok`.
 * Pure so the cron's decision is unit-testable without a DB.
 */
export function pickDriftAlerts(report: DataQualityReport): DriftAlert[] {
  return report.completeness
    .filter((c) => c.health !== 'ok')
    .map((c) => ({
      source: c.source,
      health: c.health,
      reason: c.healthReason ?? 'zvýšená chýbovosť',
    }));
}

export type ClusterAlert = { reason: string; count: number };

/**
 * Cluster shapes that a genuine repost group cannot have.
 *
 * A threshold on maxClusterSize alone would not have helped: it stood at 682 on
 * the admin page for weeks and nobody looked. These are different in kind —
 * each one is a contradiction rather than a large number, so any value above
 * zero is a defect that can be named and found.
 */
export function pickClusterAlerts(report: DataQualityReport): ClusterAlert[] {
  const d = report.dedup;
  const alerts: ClusterAlert[] = [];
  if (d.vinConflictClusters > 0) {
    alerts.push({
      reason: 'zhluky s dvoma a viac rôznymi VIN (dve VIN = dve autá)',
      count: d.vinConflictClusters,
    });
  }
  if (d.chainedClones > 0) {
    alerts.push({ reason: 'klony ukazujúce na klon (skrytá hlava zhluku)', count: d.chainedClones });
  }
  if (d.incoherentClusters > 0) {
    alerts.push({
      reason: 'zhluky miešajúce modely, ročníky nad 2 roky alebo ceny nad 3×',
      count: d.incoherentClusters,
    });
  }
  return alerts;
}

export type SourceFreshness = {
  source: string;
  activeCanonical: number;
  /** Of active listings that have a price, the share re-read inside the SLA.
   *  Rows without a price are excluded: they have no price to go stale, and
   *  including them would pin the alert on a completeness problem. */
  pctWithinSla: number;
  slaDays: number;
  p50AgeHours: number | null;
  p90AgeHours: number | null;
  oldestAgeDays: number | null;
  neverCheckedPct: number;
};

/**
 * How long a full sweep of a source should take, from the arithmetic rather
 * than from observation.
 *
 * Deriving it matters. Today's freshness numbers look excellent — 97.7% of
 * autobazar.eu seen within 24 hours — purely because the corpus was rebuilt by
 * hand two days ago, and a threshold fitted to that would have been calibrated
 * against an artefact. These figures come from the crawl budget: pages per run
 * times runs per day against each source's page space, with headroom.
 */
export const SOURCE_SLA_DAYS: Record<string, number> = {
  'bazos.sk': 4,
  'autobazar.sk': 4,
  'autobazar.eu': 6,
};

export const DEFAULT_SLA_DAYS = 5;

export function slaDaysFor(source: string): number {
  return SOURCE_SLA_DAYS[source] ?? DEFAULT_SLA_DAYS;
}

export type FreshnessAlert = {
  source: string;
  level: 'warn' | 'error';
  reason: string;
};

/**
 * Sources whose prices have gone stale.
 *
 * Measured as the share inside the SLA rather than as a median age, and the
 * difference is not cosmetic: a median sits at "perfect" for days after a
 * rebuild and then falls off a cliff, whereas the within-SLA share starts
 * degrading in proportion on the first day the crawler falls behind. Only the
 * second one is any use as an early warning.
 */
export function pickFreshnessAlerts(report: DataQualityReport): FreshnessAlert[] {
  const alerts: FreshnessAlert[] = [];
  for (const f of report.freshness) {
    if (f.activeCanonical === 0) continue;
    if (f.pctWithinSla < 80) {
      alerts.push({
        source: f.source,
        level: 'error',
        reason: `len ${f.pctWithinSla} % cien overených za ${f.slaDays} dní`,
      });
    } else if (f.pctWithinSla < 95) {
      alerts.push({
        source: f.source,
        level: 'warn',
        reason: `${f.pctWithinSla} % cien overených za ${f.slaDays} dní`,
      });
    }
  }
  return alerts;
}

export type CountryCoverageAlert = {
  source: string;
  level: 'warn' | 'error';
  reason: string;
};

/**
 * How close each source is to being able to carry a confirmed-Slovak-only
 * reference.
 *
 * The market predicate currently means "exclude what we know is not Slovak".
 * Tightening it to "admit only confirmed Slovak" is a one-way change to what
 * gets published, so it must be gated on an observed number: this selector is
 * that number. Below 2% unknown, the tightening costs almost nothing; above
 * 20% it would silently retire a fifth of a source.
 *
 * Pure, like the other pick* selectors, so the thresholds are testable without
 * a database.
 */
export function pickCountryCoverageAlerts(report: DataQualityReport): CountryCoverageAlert[] {
  const alerts: CountryCoverageAlert[] = [];
  for (const c of report.completeness) {
    if (c.active === 0) continue;
    if (c.nullCountryPct >= 20) {
      alerts.push({
        source: c.source,
        level: 'error',
        reason: `${c.nullCountryPct} % aktívnych inzerátov nemá určenú krajinu`,
      });
    } else if (c.nullCountryPct >= 2) {
      alerts.push({
        source: c.source,
        level: 'warn',
        reason: `${c.nullCountryPct} % bez krajiny — na sprísnenie referencie treba pod 2 %`,
      });
    }
  }
  return alerts;
}

export type EnrichmentCoverage = {
  source: string;
  active: number;
  enrichedPct: number;
  sellerTypePct: number;
  vinPct: number;
  powerPct: number;
};

export type DealScoreHealth = {
  activeCanonical: number;
  flipRows: number;
  withDealScore: number;
  avgCohortSize: number | null;
};

export type DedupHealth = {
  total: number;
  canonical: number;
  repostClones: number;
  repostPct: number;
  vinCoveragePct: number;
  // Largest repost cluster (clones sharing one canonical). A wild value flags
  // over-clustering (the false-merge symptom the guard prevents).
  maxClusterSize: number;
  // VINs seen on 2+ sources — the same car cross-posted, deduped by the VIN pass.
  crossSourceVinClusters: number;
  // Clusters holding two or more different VINs. A VIN identifies a physical
  // car, so this is not a heuristic: any value above zero is a proven false
  // merge. It reached 515 once, the worst cluster holding 151 distinct VINs.
  vinConflictClusters: number;
  // Clusters that contradict themselves: more than one model, a year span over
  // two, or a top price more than three times the bottom. A genuine repost
  // cluster trips none of these; the 681-Octavia group tripped all three.
  incoherentClusters: number;
  // Clones pointing at a canonical that is itself a clone. Every consumer reads
  // "canonical_listing_id IS NULL" as canonical, so the middle of a chain is
  // invisible and its clones are hidden behind it.
  chainedClones: number;
};

export type DataQualityReport = {
  // False when the report failed to compute (DB unreachable / query error).
  // Without this, the catch path below returns all-zeros that read as a
  // healthy-but-empty corpus — a blind watchdog silently reporting "🟢 OK".
  // Consumers (the drift cron, the public status page) must treat !ok as
  // "unknown", never as healthy.
  ok: boolean;
  generatedAt: string;
  completeness: SourceCompleteness[];
  enrichment: EnrichmentCoverage[];
  dealScore: DealScoreHealth;
  dedup: DedupHealth;
  freshness: SourceFreshness[];
};

export function computeRepostPct(repostClones: number, total: number): number {
  return pct(repostClones, total);
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10; // one decimal
}

export async function getDataQualityReport(): Promise<DataQualityReport> {
  const generatedAt = new Date().toISOString();
  const nextYear = new Date().getFullYear() + 1;
  try {
    const db = getDb();

    // Null rates are computed over ACTIVE listings only. Sold/removed rows are
    // never re-scraped, so their historical nulls would otherwise (a) drown out
    // a fresh selector drift in the total and (b) keep a just-fixed source
    // pinned at "drift" forever. The `_active` FILTER on every null count is
    // what makes the drift alert actually track live extraction health.
    const ACTIVE = sql`canonical_listing_id IS NULL AND sold_at IS NULL AND removed_at IS NULL`;
    const completenessRows = (await db.execute(sql`
      SELECT
        source,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ${ACTIVE})::int AS active,
        COUNT(*) FILTER (WHERE ${ACTIVE} AND price_eur IS NULL)::int AS null_price,
        COUNT(*) FILTER (WHERE ${ACTIVE} AND year IS NULL)::int AS null_year,
        COUNT(*) FILTER (WHERE ${ACTIVE} AND mileage_km IS NULL)::int AS null_mileage,
        COUNT(*) FILTER (WHERE ${ACTIVE} AND fuel IS NULL)::int AS null_fuel,
        COUNT(*) FILTER (WHERE ${ACTIVE} AND transmission IS NULL)::int AS null_transmission,
        COUNT(*) FILTER (WHERE ${ACTIVE} AND region IS NULL)::int AS null_region,
        COUNT(*) FILTER (WHERE ${ACTIVE} AND model_id IS NULL)::int AS null_model,
        COUNT(*) FILTER (WHERE ${ACTIVE} AND country IS NULL)::int AS null_country,
        COUNT(*) FILTER (
          WHERE ${ACTIVE} AND price_eur IS NOT NULL AND (price_eur < ${PRICE_MIN} OR price_eur > ${PRICE_MAX})
        )::int AS outlier_price,
        COUNT(*) FILTER (
          WHERE ${ACTIVE} AND mileage_km IS NOT NULL AND mileage_km > ${MILEAGE_MAX}
        )::int AS outlier_mileage,
        COUNT(*) FILTER (
          WHERE ${ACTIVE}
            AND model_id IS NOT NULL
            AND price_eur IS NOT NULL AND price_eur >= ${PRICE_MIN} AND price_eur <= ${PRICE_MAX}
            AND year IS NOT NULL AND year >= ${YEAR_MIN} AND year <= ${nextYear}
            AND mileage_km IS NOT NULL AND mileage_km >= 0 AND mileage_km <= ${MILEAGE_MAX}
        )::int AS cohort_ready
      FROM listings
      GROUP BY source
      ORDER BY source
    `)) as unknown as Array<{
      source: string;
      total: number;
      active: number;
      null_price: number;
      null_year: number;
      null_mileage: number;
      null_fuel: number;
      null_transmission: number;
      null_region: number;
      null_model: number;
      null_country: number;
      outlier_price: number;
      outlier_mileage: number;
      cohort_ready: number;
    }>;

    const completeness: SourceCompleteness[] = completenessRows.map((r) => {
      const nullPricePct = pct(r.null_price, r.active);
      const nullRegionPct = pct(r.null_region, r.active);
      const nullModelPct = pct(r.null_model, r.active);
      const { health, healthReason } = assessHealth({ nullPricePct, nullModelPct, nullRegionPct });
      return {
        source: r.source,
        total: r.total,
        active: r.active,
        nullPricePct,
        nullYearPct: pct(r.null_year, r.active),
        nullMileagePct: pct(r.null_mileage, r.active),
        nullFuelPct: pct(r.null_fuel, r.active),
        nullTransmissionPct: pct(r.null_transmission, r.active),
        nullRegionPct,
        nullModelPct,
        nullCountryPct: pct(r.null_country, r.active),
        outlierPrice: r.outlier_price,
        outlierMileage: r.outlier_mileage,
        cohortReadyPct: pct(r.cohort_ready, r.active),
        health,
        healthReason,
      };
    });

    const enrichmentRows = (await db.execute(sql`
      SELECT
        l.source,
        COUNT(*)::int AS active,
        COUNT(ld.listing_id)::int AS enriched,
        COUNT(ld.seller_type)::int AS has_seller_type,
        COUNT(ld.vin)::int AS has_vin,
        COUNT(ld.power_kw)::int AS has_power
      FROM listings l
      LEFT JOIN listing_details ld ON ld.listing_id = l.id
      WHERE l.canonical_listing_id IS NULL AND l.sold_at IS NULL AND l.removed_at IS NULL
      GROUP BY l.source
      ORDER BY l.source
    `)) as unknown as Array<{
      source: string;
      active: number;
      enriched: number;
      has_seller_type: number;
      has_vin: number;
      has_power: number;
    }>;

    const enrichment: EnrichmentCoverage[] = enrichmentRows.map((r) => ({
      source: r.source,
      active: r.active,
      enrichedPct: pct(r.enriched, r.active),
      sellerTypePct: pct(r.has_seller_type, r.active),
      vinPct: pct(r.has_vin, r.active),
      powerPct: pct(r.has_power, r.active),
    }));

    const dealRows = (await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM listings
          WHERE canonical_listing_id IS NULL AND sold_at IS NULL AND removed_at IS NULL)::int AS active_canonical,
        (SELECT COUNT(*) FROM flip_opportunities)::int AS flip_rows,
        (SELECT COUNT(*) FROM flip_opportunities WHERE deal_score IS NOT NULL)::int AS with_deal_score,
        (SELECT AVG(cohort_size) FROM flip_opportunities)::float8 AS avg_cohort_size
    `)) as unknown as Array<{
      active_canonical: number;
      flip_rows: number;
      with_deal_score: number;
      avg_cohort_size: number | null;
    }>;

    const d = dealRows[0];
    const dealScore: DealScoreHealth = {
      activeCanonical: d?.active_canonical ?? 0,
      flipRows: d?.flip_rows ?? 0,
      withDealScore: d?.with_deal_score ?? 0,
      avgCohortSize: d?.avg_cohort_size != null ? Math.round(d.avg_cohort_size * 10) / 10 : null,
    };

    const dedupRows = (await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM listings)::int AS total,
        (SELECT COUNT(*) FROM listings WHERE canonical_listing_id IS NULL)::int AS canonical,
        (SELECT COUNT(*) FROM listings WHERE canonical_listing_id IS NOT NULL)::int AS repost_clones,
        (SELECT COUNT(*) FROM listing_details WHERE vin IS NOT NULL AND LENGTH(vin) = 17)::int AS with_vin,
        (SELECT COALESCE(MAX(cnt), 0) FROM (
          SELECT COUNT(*) AS cnt FROM listings
          WHERE canonical_listing_id IS NOT NULL GROUP BY canonical_listing_id
        ) g)::int AS max_cluster_clones,
        (SELECT COUNT(*) FROM (
          SELECT d2.vin FROM listing_details d2 JOIN listings l2 ON l2.id = d2.listing_id
          WHERE d2.vin IS NOT NULL AND LENGTH(d2.vin) = 17
          GROUP BY d2.vin HAVING COUNT(DISTINCT l2.source) > 1
        ) x)::int AS cross_source_vin,
        (SELECT COUNT(*) FROM (
          SELECT l3.canonical_listing_id
          FROM listings l3 JOIN listing_details d3 ON d3.listing_id = l3.id
          WHERE l3.canonical_listing_id IS NOT NULL
            AND d3.vin IS NOT NULL AND LENGTH(d3.vin) = 17
          GROUP BY l3.canonical_listing_id HAVING COUNT(DISTINCT d3.vin) > 1
        ) v)::int AS vin_conflict_clusters,
        (SELECT COUNT(*) FROM (
          SELECT canonical_listing_id FROM listings
          WHERE canonical_listing_id IS NOT NULL
          GROUP BY canonical_listing_id
          HAVING COUNT(DISTINCT model_id) > 1
              OR MAX(year) - MIN(year) > 2
              OR MAX(price_eur) > 3 * NULLIF(MIN(price_eur), 0)
        ) i)::int AS incoherent_clusters,
        (SELECT COUNT(*) FROM listings l4 JOIN listings c4 ON c4.id = l4.canonical_listing_id
          WHERE c4.canonical_listing_id IS NOT NULL)::int AS chained_clones
    `)) as unknown as Array<{
      total: number;
      canonical: number;
      repost_clones: number;
      with_vin: number;
      max_cluster_clones: number;
      cross_source_vin: number;
      vin_conflict_clusters: number;
      incoherent_clusters: number;
      chained_clones: number;
    }>;
    const dr = dedupRows[0];
    const dedup: DedupHealth = {
      total: dr?.total ?? 0,
      canonical: dr?.canonical ?? 0,
      repostClones: dr?.repost_clones ?? 0,
      repostPct: computeRepostPct(dr?.repost_clones ?? 0, dr?.total ?? 0),
      vinCoveragePct: pct(dr?.with_vin ?? 0, dr?.total ?? 0),
      // +1 so the count includes the canonical itself (cluster = canonical + clones).
      maxClusterSize: (dr?.max_cluster_clones ?? 0) > 0 ? (dr?.max_cluster_clones ?? 0) + 1 : 0,
      crossSourceVinClusters: dr?.cross_source_vin ?? 0,
      vinConflictClusters: dr?.vin_conflict_clusters ?? 0,
      incoherentClusters: dr?.incoherent_clusters ?? 0,
      chainedClones: dr?.chained_clones ?? 0,
    };

    // Freshness is measured on price_checked_at, never on last_seen_at:
    // check-removed stamps last_seen_at after a HEAD request, which reads no
    // price, so two of three sources would report perfect freshness while
    // their prices went stale.
    const freshRows = (await db.execute(sql`
      SELECT l.source,
        COUNT(*)::int AS active,
        COUNT(*) FILTER (WHERE l.price_checked_at IS NULL)::int AS never_checked,
        EXTRACT(EPOCH FROM percentile_cont(0.5) WITHIN GROUP (
          ORDER BY now() - l.price_checked_at))/3600 AS p50_h,
        EXTRACT(EPOCH FROM percentile_cont(0.9) WITHIN GROUP (
          ORDER BY now() - l.price_checked_at))/3600 AS p90_h,
        EXTRACT(EPOCH FROM max(now() - l.price_checked_at))/86400 AS oldest_d,
        COUNT(*) FILTER (WHERE l.price_checked_at > now() - (
          CASE l.source WHEN 'bazos.sk' THEN 4 WHEN 'autobazar.sk' THEN 4
               WHEN 'autobazar.eu' THEN 6 ELSE 5 END * interval '1 day'))::int AS within_sla
      FROM listings l
      WHERE l.canonical_listing_id IS NULL
        AND l.sold_at IS NULL
        AND l.removed_at IS NULL
        -- Only rows that have a price. A listing with no price cannot have a
        -- stale one, and counting it here would hold bazos.sk permanently red
        -- over a coverage problem — an alert nobody can ever clear is one
        -- people learn to ignore, which is the failure this metric exists to
        -- prevent. Rows without a price are a completeness question, and
        -- completeness already reports them.
        AND l.price_eur IS NOT NULL
      GROUP BY l.source
    `)) as unknown as Array<{
      source: string;
      active: number;
      never_checked: number;
      p50_h: string | number | null;
      p90_h: string | number | null;
      oldest_d: string | number | null;
      within_sla: number;
    }>;
    const num = (v: string | number | null) =>
      v == null ? null : Math.round(Number(v) * 10) / 10;
    const freshness: SourceFreshness[] = freshRows.map((r) => ({
      source: r.source,
      activeCanonical: r.active,
      pctWithinSla: pct(r.within_sla, r.active),
      slaDays: slaDaysFor(r.source),
      p50AgeHours: num(r.p50_h),
      p90AgeHours: num(r.p90_h),
      oldestAgeDays: num(r.oldest_d),
      neverCheckedPct: pct(r.never_checked, r.active),
    }));

    return { ok: true, generatedAt, completeness, enrichment, dealScore, dedup, freshness };
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'data-quality', step: 'getDataQualityReport' } });
    return {
      ok: false,
      generatedAt,
      completeness: [],
      enrichment: [],
      dealScore: { activeCanonical: 0, flipRows: 0, withDealScore: 0, avgCohortSize: null },
      dedup: {
        total: 0,
        canonical: 0,
        repostClones: 0,
        repostPct: 0,
        vinCoveragePct: 0,
        maxClusterSize: 0,
        crossSourceVinClusters: 0,
        vinConflictClusters: 0,
        incoherentClusters: 0,
        chainedClones: 0,
      },
      freshness: [],
    };
  }
}

// ── Public status surface ────────────────────────────────────────────────
// A curated, no-auth subset of the report for a public /status page. Trimmed
// to health + the coverage a visitor can reason about (price/model/cohort),
// deliberately omitting internal dedup mechanics and raw business totals.

export type PublicSourceHealth = {
  source: string;
  active: number;
  health: SourceHealth;
  nullPricePct: number;
  nullModelPct: number;
  cohortReadyPct: number;
  /**
   * Share of active listings whose detail page has been fetched, and the share
   * of prices re-read inside the source's SLA.
   *
   * Both were computed already and neither reached this page, so a stalled
   * enrichment or a source that had stopped responding was invisible here —
   * the only way to notice was to ask someone to run a query. The backlog once
   * sat at 16 318 while this page reported every source healthy.
   */
  enrichedPct: number;
  freshWithinSlaPct: number;
};

export type PublicDataHealth = {
  ok: boolean;
  generatedAt: string;
  // Worst source health, or 'unknown' when the report failed / has no data —
  // never silently 'ok' on a blind read.
  overall: SourceHealth | 'unknown';
  totalActive: number;
  repostPct: number;
  sources: PublicSourceHealth[];
  /**
   * How old these numbers are, in hours, measured when the page asked for them.
   *
   * Computed OUTSIDE the cache on purpose: generatedAt is cached along with
   * everything else, so an age derived from it inside the cached function would
   * read as zero for as long as the entry lives. This page served a report six
   * days old without saying so; the age has to come from the request.
   */
  ageHours: number;
};

const HEALTH_RANK: Record<SourceHealth, number> = { ok: 0, warn: 1, drift: 2 };

/** Pure projection — testable without a DB. */
/** Everything except `ageHours`, which only the request can know. */
export type CachedDataHealth = Omit<PublicDataHealth, 'ageHours'>;

export function toPublicDataHealth(r: DataQualityReport): CachedDataHealth {
  const overall: SourceHealth | 'unknown' =
    !r.ok || r.completeness.length === 0
      ? 'unknown'
      : r.completeness.reduce<SourceHealth>(
          (worst, c) => (HEALTH_RANK[c.health] > HEALTH_RANK[worst] ? c.health : worst),
          'ok',
        );
  return {
    ok: r.ok,
    generatedAt: r.generatedAt,
    overall,
    totalActive: r.completeness.reduce((sum, c) => sum + c.active, 0),
    repostPct: r.dedup.repostPct,
    sources: r.completeness.map((c) => ({
      source: c.source,
      active: c.active,
      health: c.health,
      nullPricePct: c.nullPricePct,
      nullModelPct: c.nullModelPct,
      cohortReadyPct: c.cohortReadyPct,
      enrichedPct: r.enrichment.find((e) => e.source === c.source)?.enrichedPct ?? 0,
      freshWithinSlaPct: r.freshness.find((f) => f.source === c.source)?.pctWithinSla ?? 0,
    })),
  };
}

// Cache the heavy aggregation so the public page can't be used to hammer the
// DB: at most one full report per 10 min, shared across all visitors. The
// wrapper re-throws on a failed report so unstable_cache never caches the
// blind state (a transient DB blip retries on the next request, not 10 min
// later).
const loadPublicHealth = unstable_cache(
  async (): Promise<CachedDataHealth> => {
    const report = await getDataQualityReport();
    if (!report.ok) throw new Error('data_quality_report_failed');
    return toPublicDataHealth(report);
  },
  ['public-data-health'],
  { revalidate: 600, tags: ['data-health'] },
);

export async function getPublicDataHealth(): Promise<PublicDataHealth> {
  try {
    const health = await loadPublicHealth();
    const ageHours = (Date.now() - new Date(health.generatedAt).getTime()) / 3_600_000;
    return { ...health, ageHours };
  } catch {
    return {
      ok: false,
      generatedAt: new Date().toISOString(),
      overall: 'unknown',
      totalActive: 0,
      repostPct: 0,
      sources: [],
      ageHours: 0,
    };
  }
}

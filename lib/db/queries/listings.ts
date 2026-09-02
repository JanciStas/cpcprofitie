// Read-side query helpers for the listings table. Used by the `/app/listings`
// UI to paginate over scraped inventory. No write paths live here — those
// stay in `lib/scraping/persist.ts`.

import * as Sentry from '@sentry/nextjs';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { unstable_cache } from 'next/cache';

/**
 * Revalidation tag for everything on this page that counts listings.
 *
 * Two separate failures made this necessary, both measured:
 *
 *  1. `revalidate` does not fire. /status sat on a report six days old with
 *     `revalidate: 600`, and the next morning was still 18 hours stale. The
 *     docs also say unstable_cache "persists the result across requests AND
 *     DEPLOYMENTS", so shipping does not clear it either. Without a tag there
 *     was no way to refresh these at all -- the corpus grew past 145 000 active
 *     listings while the page kept showing an older number.
 *  2. The graceful DB-outage fallback used to be computed INSIDE the cached
 *     function, so one blip stored zeros (or an empty model list) for the whole
 *     window. The cached half now throws and the wrapper catches, which is what
 *     getPublicDataHealth already does for the same reason.
 *
 * Refreshed by the daily data-quality watchdog.
 */
export const CACHE_TAG_LISTINGS = 'listings-counts';
import { getDb } from '../index';
import {
  listingDetails,
  listingPhotos,
  listings,
  vehicleMakes,
  vehicleModels,
} from '../schema';
import { SK_KRAJE, krajByName } from '@/lib/data/sk-regions';
import type { RawFuel, RawTransmission, Source } from '@/lib/scraping/types';

export type ListingsSort = 'newest' | 'oldest' | 'price-asc' | 'price-desc';

export type ListingFilters = {
  source?: Source | Source[];
  /** Substring match against make name. autobazar.eu sitemap listings have
   *  no title, so search hits the joined make/model name instead. */
  q?: string;
  minPrice?: number;
  maxPrice?: number;
  minYear?: number;
  maxYear?: number;
  minKm?: number;
  maxKm?: number;
  fuel?: RawFuel | RawFuel[];
  transmission?: RawTransmission | RawTransmission[];
  regions?: string[];
  hasPhoto?: boolean;
  featuredOnly?: boolean;
};

export type ListingRow = {
  id: bigint;
  source: Source;
  sourceId: string;
  url: string;
  makeName: string | null;
  modelName: string | null;
  rawTitle: string | null;
  priceEur: number | null;
  year: number | null;
  mileageKm: number | null;
  fuel: RawFuel | null;
  region: string | null;
  firstSeenAt: Date;
  heroPhotoUrl: string | null;
  viewCount: number | null;
  isFeatured: boolean;
};

export type ListingDetailFull = ListingRow & {
  description: string | null;
  vin: string | null;
  bodyType: string | null;
  colorExterior: string | null;
  powerKw: number | null;
  engineCcm: number | null;
  sellerType: 'private' | 'dealer' | null;
  sellerName: string | null;
  equipment: string[];
  photos: string[];
};

type GetListingsOpts = {
  page: number;
  perPage: number;
  filters?: ListingFilters;
  sort?: ListingsSort;
};

function buildWhere(filters: ListingFilters | undefined) {
  const parts: SQL[] = [];
  // Active-only default: exclude soft-removed rows from all UI queries.
  parts.push(isNull(listings.removedAt));

  if (filters) {
    if (filters.source) {
      if (Array.isArray(filters.source)) {
        if (filters.source.length > 0)
          parts.push(inArray(listings.source, filters.source));
      } else {
        parts.push(eq(listings.source, filters.source));
      }
    }
    if (filters.minPrice != null)
      parts.push(gte(listings.priceEur, String(filters.minPrice)));
    if (filters.maxPrice != null)
      parts.push(lte(listings.priceEur, String(filters.maxPrice)));
    if (filters.minYear != null) parts.push(gte(listings.year, filters.minYear));
    if (filters.maxYear != null) parts.push(lte(listings.year, filters.maxYear));
    if (filters.minKm != null) parts.push(gte(listings.mileageKm, filters.minKm));
    if (filters.maxKm != null) parts.push(lte(listings.mileageKm, filters.maxKm));
    if (filters.fuel) {
      if (Array.isArray(filters.fuel)) {
        if (filters.fuel.length > 0) parts.push(inArray(listings.fuel, filters.fuel));
      } else {
        parts.push(eq(listings.fuel, filters.fuel));
      }
    }
    if (filters.transmission) {
      if (Array.isArray(filters.transmission)) {
        if (filters.transmission.length > 0)
          parts.push(inArray(listings.transmission, filters.transmission));
      } else {
        parts.push(eq(listings.transmission, filters.transmission));
      }
    }
    if (filters.regions && filters.regions.length > 0) {
      // Treat filters.regions as kraj names (Bratislavský, Žilinský, …).
      // Each kraj fans out into multiple ILIKE patterns OR'd together;
      // selected kraje are then OR'd with each other.
      const krajConditions = filters.regions
        .map((n) => krajByName(n))
        .filter((k): k is (typeof SK_KRAJE)[number] => Boolean(k))
        .map((k) =>
          or(...k.patterns.map((p) => ilike(listings.region, p))),
        )
        .filter((c): c is NonNullable<typeof c> => c != null);
      if (krajConditions.length > 0) {
        const combined = or(...krajConditions);
        if (combined) parts.push(combined);
      }
    }
    if (filters.hasPhoto === true) {
      parts.push(
        exists(
          getDb()
            .select({ x: sql`1` })
            .from(listingPhotos)
            .where(eq(listingPhotos.listingId, listings.id)),
        ),
      );
    }
    if (filters.featuredOnly === true) {
      parts.push(eq(listings.isFeatured, true));
    }
    if (filters.q && filters.q.trim()) {
      const needle = `%${filters.q.trim()}%`;
      parts.push(
        sql`(${vehicleMakes.name} ILIKE ${needle} OR ${vehicleModels.name} ILIKE ${needle})`,
      );
    }
  }

  return and(...parts);
}

function orderBy(sort: ListingsSort) {
  switch (sort) {
    case 'oldest':
      return [asc(listings.firstSeenAt), asc(listings.id)];
    case 'price-asc':
      return [asc(listings.priceEur), desc(listings.id)];
    case 'price-desc':
      return [desc(listings.priceEur), desc(listings.id)];
    case 'newest':
    default:
      return [desc(listings.firstSeenAt), desc(listings.id)];
  }
}

export async function getListings(
  opts: GetListingsOpts,
): Promise<{ rows: ListingRow[]; total: number }> {
  try {
    return await getListingsUnsafe(opts);
  } catch (e) {
    // Graceful-empty on DB unavailability, matching the other query modules.
    Sentry.captureException(e, { tags: { component: 'listings', step: 'getListings' } });
    return { rows: [], total: 0 };
  }
}

async function getListingsUnsafe(
  opts: GetListingsOpts,
): Promise<{ rows: ListingRow[]; total: number }> {
  const db = getDb();
  const page = Math.max(1, opts.page);
  const perPage = Math.min(200, Math.max(1, opts.perPage));
  const offset = (page - 1) * perPage;
  const filters = opts.filters;
  const sort = opts.sort ?? 'newest';
  const where = buildWhere(filters);

  // Hero photo subquery: pull position=1 for each listing in one LEFT JOIN.
  const heroPhoto = db
    .$with('hero_photo')
    .as(
      db
        .select({
          listingId: listingPhotos.listingId,
          url: listingPhotos.url,
        })
        .from(listingPhotos)
        .where(eq(listingPhotos.position, 1)),
    );

  const rowsP = db
    .with(heroPhoto)
    .select({
      id: listings.id,
      source: listings.source,
      sourceId: listings.sourceId,
      url: listings.url,
      makeName: vehicleMakes.name,
      modelName: vehicleModels.name,
      rawTitle: listings.rawTitle,
      priceEur: listings.priceEur,
      year: listings.year,
      mileageKm: listings.mileageKm,
      fuel: listings.fuel,
      region: listings.region,
      firstSeenAt: listings.firstSeenAt,
      heroPhotoUrl: heroPhoto.url,
      viewCount: listings.viewCount,
      isFeatured: listings.isFeatured,
    })
    .from(listings)
    .leftJoin(vehicleModels, eq(vehicleModels.id, listings.modelId))
    .leftJoin(vehicleMakes, eq(vehicleMakes.id, vehicleModels.makeId))
    .leftJoin(heroPhoto, eq(heroPhoto.listingId, listings.id))
    .where(where)
    .orderBy(...orderBy(sort))
    .limit(perPage)
    .offset(offset);

  const totalP = db
    .select({ n: sql<number>`count(*)::int` })
    .from(listings)
    .leftJoin(vehicleModels, eq(vehicleModels.id, listings.modelId))
    .leftJoin(vehicleMakes, eq(vehicleMakes.id, vehicleModels.makeId))
    .where(where);

  const [rows, totalRows] = await Promise.all([rowsP, totalP]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      source: r.source as Source,
      sourceId: r.sourceId,
      url: r.url,
      makeName: r.makeName ?? null,
      modelName: r.modelName ?? null,
      rawTitle: r.rawTitle ?? null,
      priceEur: r.priceEur != null ? Number(r.priceEur) : null,
      year: r.year,
      mileageKm: r.mileageKm,
      fuel: (r.fuel ?? null) as RawFuel | null,
      region: r.region,
      firstSeenAt: r.firstSeenAt,
      heroPhotoUrl: r.heroPhotoUrl,
      viewCount: r.viewCount ?? null,
      isFeatured: r.isFeatured ?? false,
    })),
    total: totalRows[0]?.n ?? 0,
  };
}

export async function getListingById(
  id: bigint,
): Promise<ListingDetailFull | null> {
  try {
    return await getListingByIdUnsafe(id);
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'listings', step: 'getListingById' } });
    return null;
  }
}

async function getListingByIdUnsafe(
  id: bigint,
): Promise<ListingDetailFull | null> {
  const db = getDb();
  const [base] = await db
    .select({
      id: listings.id,
      source: listings.source,
      sourceId: listings.sourceId,
      url: listings.url,
      makeName: vehicleMakes.name,
      modelName: vehicleModels.name,
      rawTitle: listings.rawTitle,
      priceEur: listings.priceEur,
      year: listings.year,
      mileageKm: listings.mileageKm,
      fuel: listings.fuel,
      region: listings.region,
      firstSeenAt: listings.firstSeenAt,
      viewCount: listings.viewCount,
      isFeatured: listings.isFeatured,
      description: listingDetails.description,
      vin: listingDetails.vin,
      bodyType: listingDetails.bodyType,
      colorExterior: listingDetails.colorExterior,
      powerKw: listingDetails.powerKw,
      engineCcm: listingDetails.engineCcm,
      sellerType: listingDetails.sellerType,
      sellerName: listingDetails.sellerName,
      equipment: listingDetails.equipment,
    })
    .from(listings)
    .leftJoin(vehicleModels, eq(vehicleModels.id, listings.modelId))
    .leftJoin(vehicleMakes, eq(vehicleMakes.id, vehicleModels.makeId))
    .leftJoin(listingDetails, eq(listingDetails.listingId, listings.id))
    .where(eq(listings.id, id))
    .limit(1);

  if (!base) return null;

  const photoRows = await db
    .select({ url: listingPhotos.url, position: listingPhotos.position })
    .from(listingPhotos)
    .where(eq(listingPhotos.listingId, id))
    .orderBy(asc(listingPhotos.position));

  const photos = photoRows.map((p) => p.url);

  return {
    id: base.id,
    source: base.source as Source,
    sourceId: base.sourceId,
    url: base.url,
    makeName: base.makeName ?? null,
    modelName: base.modelName ?? null,
    rawTitle: base.rawTitle ?? null,
    priceEur: base.priceEur != null ? Number(base.priceEur) : null,
    year: base.year,
    mileageKm: base.mileageKm,
    fuel: (base.fuel ?? null) as RawFuel | null,
    region: base.region,
    firstSeenAt: base.firstSeenAt,
    heroPhotoUrl: photos[0] ?? null,
    viewCount: base.viewCount ?? null,
    isFeatured: base.isFeatured ?? false,
    description: base.description,
    vin: base.vin,
    bodyType: base.bodyType,
    colorExterior: base.colorExterior,
    powerKw: base.powerKw,
    engineCcm: base.engineCcm,
    sellerType: base.sellerType,
    sellerName: base.sellerName,
    equipment: Array.isArray(base.equipment) ? (base.equipment as string[]) : [],
    photos,
  };
}

export type SourceCount = { source: Source; count: number };

export async function getSourceCounts(): Promise<SourceCount[]> {
  try {
    const db = getDb();
    const rows = await db
      .select({
        source: listings.source,
        n: sql<number>`count(*)::int`,
      })
      .from(listings)
      .groupBy(listings.source)
      .orderBy(desc(sql`count(*)`));
    return rows.map((r) => ({ source: r.source as Source, count: r.n }));
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'listings', step: 'getSourceCounts' } });
    return [];
  }
}

export type ListingsStats = {
  totalListings: number;
  totalPhotos: number;
  totalEnriched: number;
  bySource: SourceCount[];
};

export type RegionGroup = { name: string; count: number };

// Cached: 8 ILIKE COUNT queries with leading-wildcard patterns can't use an
// index, so each request fanout would stack 8 sequential seqscans over 93k
// rows and saturate Postgres. The kraj counts only drift slowly with new
// listings, so a 10-minute revalidation window is fine.
const loadRegionGroups = unstable_cache(
  async (): Promise<RegionGroup[]> => {
    // Throws rather than returning zeros, because unstable_cache would store
    // the zeros. See the note on CACHE_TAG_LISTINGS.
    const db = getDb();
    const results = await Promise.all(
      SK_KRAJE.map(async (k) => {
        const condition = or(...k.patterns.map((p) => ilike(listings.region, p)));
        const rows = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(listings)
          .where(and(isNull(listings.removedAt), condition));
        return { name: k.name, count: rows[0]?.n ?? 0 };
      }),
    );
    return results;
  },
  ['listings-region-groups'],
  { revalidate: 600, tags: [CACHE_TAG_LISTINGS] },
);

export async function getRegionGroups(): Promise<RegionGroup[]> {
  try {
    return await loadRegionGroups();
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'listings', step: 'getRegionGroups' } });
    return SK_KRAJE.map((k) => ({ name: k.name, count: 0 }));
  }
}

export type TopMake = { name: string; count: number };

// Top N makes by active listing count. Used by the v2 listings UI for the
// horizontal brand-chip strip under the search input.
const loadTopMakes = unstable_cache(
  async (limit = 10): Promise<TopMake[]> => {
    const db = getDb();
    const rows = await db
      .select({
        name: vehicleMakes.name,
        n: sql<number>`count(*)::int`,
      })
      .from(listings)
      .leftJoin(vehicleModels, eq(vehicleModels.id, listings.modelId))
      .leftJoin(vehicleMakes, eq(vehicleMakes.id, vehicleModels.makeId))
      .where(and(isNull(listings.removedAt), sql`${vehicleMakes.name} IS NOT NULL`))
      .groupBy(vehicleMakes.name)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);
    return rows
      .filter((r): r is { name: string; n: number } => r.name != null)
      .map((r) => ({ name: r.name, count: r.n }));
  },
  ['listings-top-makes'],
  { revalidate: 600, tags: [CACHE_TAG_LISTINGS] },
);

export async function getTopMakes(limit = 10): Promise<TopMake[]> {
  try {
    return await loadTopMakes(limit);
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'listings', step: 'getTopMakes' } });
    return [];
  }
}

export async function getDistinctRegions(): Promise<string[]> {
  try {
    const db = getDb();
    const rows = await db
      .selectDistinct({ region: listings.region })
      .from(listings)
      .where(sql`${listings.region} IS NOT NULL`)
      .orderBy(asc(listings.region));
    return rows
      .map((r) => r.region)
      .filter((v): v is string => v != null);
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'listings', step: 'getDistinctRegions' } });
    return [];
  }
}

// Cached: 4 COUNT queries per request was producing stacking DB load under
// concurrent traffic. Stats values drift slowly (new listings every 6h via
// cron), so a 10-minute window is plenty for the header strip and ROZLOŽENIE.
const loadListingsStats = unstable_cache(
  async (): Promise<ListingsStats> => {
    const db = getDb();
    const [listingsCount, photosCount, enrichedCount, bySource] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(listings),
      db.select({ n: sql<number>`count(*)::int` }).from(listingPhotos),
      db.select({ n: sql<number>`count(*)::int` }).from(listingDetails),
      getSourceCounts(),
    ]);
    return {
      totalListings: listingsCount[0]?.n ?? 0,
      totalPhotos: photosCount[0]?.n ?? 0,
      totalEnriched: enrichedCount[0]?.n ?? 0,
      bySource,
    };
  },
  ['listings-stats'],
  { revalidate: 600, tags: [CACHE_TAG_LISTINGS] },
);

export async function getListingsStats(): Promise<ListingsStats> {
  try {
    return await loadListingsStats();
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'listings', step: 'getListingsStats' } });
    return { totalListings: 0, totalPhotos: 0, totalEnriched: 0, bySource: [] };
  }
}

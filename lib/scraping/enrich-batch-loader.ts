// Shared helper that selects listings to enrich for one source, in batches.
// Used by both the local enrich-all scripts and the server-side
// /api/cron/enrich-source endpoint.
//
// mode:
//   'unenriched' (default) — listings with no listing_details row yet.
//   'null-price'           — active listings still missing a price, regardless
//                            of enrichment status. Backfills price from the
//                            detail page for old rows scraped before the
//                            listing-page parser extracted price.
//   'null-locality'        — same shape, for rows enriched before the locality
//                            was read from the meta tag. 'unenriched' cannot
//                            reach them: they already have a detail row.
//   'null-country'         — rows whose market is still unknown. This is what
//                            the reference-tightening gate waits on, and the
//                            detail page carries the location tree that
//                            answers it.

import { and, desc, eq, exists, gt, isNull, notExists, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { listingDetails, listings } from '../db/schema';
import type { NormalizedListing, Source } from './types';

export type PartitionOpts = { index: number; modulo: number };
export type EnrichSelectMode =
  | 'unenriched'
  | 'unenriched-newest'
  | 'null-description'
  | 'null-price'
  | 'null-model'
  | 'null-locality'
  | 'null-country'
  | 'null-vin'
  | 'stale-price';

export async function loadUnenrichedBatch(
  source: Source,
  size: number,
  partition?: PartitionOpts,
  mode: EnrichSelectMode = 'unenriched',
  // Cursor for the 'null-price' / 'null-model' backfill modes: rows whose
  // detail yields no price/model stay NULL and would be re-selected forever
  // without this. The caller advances it past each batch (read from
  // rawPayload.__cursorId). Ignored in 'unenriched' mode, which self-advances
  // as rows gain a listing_details row.
  afterId?: bigint,
): Promise<NormalizedListing[]> {
  const db = getDb();
  // id-based partitioning lets N parallel loops work on disjoint subsets of
  // listings without `FOR UPDATE SKIP LOCKED`. Each shell gets (index, modulo)
  // and we filter `id % modulo = index`.
  const partitionFilter =
    partition && partition.modulo > 1
      ? sql`(${listings.id} % ${partition.modulo}) = ${partition.index}`
      : undefined;
  // A detail row exists but carries no description: these came in through the
  // sitemap import, which created the row without ever fetching the page. The
  // 'unenriched' mode cannot see them, because it asks whether a detail row
  // exists at all — 8 568 autobazar.eu listings were therefore permanently
  // invisible to enrichment, missing VIN, power and seller.
  const nullDescriptionFilter = and(
    isNull(listings.canonicalListingId),
    isNull(listings.soldAt),
    isNull(listings.removedAt),
    afterId != null ? gt(listings.id, afterId) : undefined,
    exists(
      db
        .select({ x: sql`1` })
        .from(listingDetails)
        .where(and(eq(listingDetails.listingId, listings.id), isNull(listingDetails.description))),
    ),
  );

  // 'null-vin' is the odd one out: VIN lives on listing_details, not on
  // listings, so it cannot join the column-based group below. It exists because
  // autobazar.sk had a VIN on every detail page and we had recorded none --
  // those rows are fully enriched, so no other mode would ever look at them
  // again.
  const nullVinFilter = and(
    exists(
      db
        .select({ x: sql`1` })
        .from(listingDetails)
        .where(and(eq(listingDetails.listingId, listings.id), isNull(listingDetails.vin))),
    ),
    isNull(listings.canonicalListingId),
    isNull(listings.soldAt),
    isNull(listings.removedAt),
    afterId != null ? gt(listings.id, afterId) : undefined,
  );

  // 'stale-price' is the only mode that looks for an OLD value rather than a
  // missing one, and it exists because that gap had a cost.
  //
  // bazos.sk repeats its last page past a certain depth, so the catalogue walk
  // reaches about 20 000 of its 60 000 active listings. The other ~40 000 can
  // only be re-read by id — which this pass does — but every other mode asks
  // "is this field empty?", and those rows have both a detail row and a price.
  // Nothing would ever have revisited them, so their prices were frozen for
  // good while still counting in the reference medians.
  //
  // Ordering by price_checked_at makes it self-targeting: the catalogue walk
  // keeps whatever it can reach fresh, so the stalest rows ARE the unreachable
  // ones. No list of which pages the source hides has to be maintained.
  const stalePriceFilter = and(
    isNull(listings.canonicalListingId),
    isNull(listings.soldAt),
    isNull(listings.removedAt),
    sql`${listings.priceCheckedAt} IS NULL
        OR ${listings.priceCheckedAt} < now() - interval '7 days'`,
  );

  const selectFilter =
    mode === 'stale-price'
      ? stalePriceFilter
      : mode === 'null-vin'
      ? nullVinFilter
      : mode === 'null-description'
      ? nullDescriptionFilter
      : mode === 'null-price' ||
        mode === 'null-model' ||
        mode === 'null-locality' ||
        mode === 'null-country'
      ? and(
          // The target-column IS NULL among active listings, walked by an id
          // cursor so rows that stay NULL even after enrichment (e.g. gone)
          // don't get re-selected forever.
          mode === 'null-price'
            ? isNull(listings.priceEur)
            : mode === 'null-model'
              ? isNull(listings.modelId)
              : mode === 'null-country'
                ? isNull(listings.country)
                : isNull(listings.locality),
          isNull(listings.canonicalListingId),
          isNull(listings.soldAt),
          isNull(listings.removedAt),
          afterId != null ? gt(listings.id, afterId) : undefined,
        )
      : notExists(
          db
            .select({ x: sql`1` })
            .from(listingDetails)
            .where(eq(listingDetails.listingId, listings.id)),
        );

  // 'unenriched' walks oldest-first, which is right for grinding down a
  // backlog and wrong for everything else: with tens of thousands of old rows
  // queued, a listing that appeared this morning would wait behind all of them
  // — and a new listing is exactly the one a flip opportunity is about.
  // 'stale-price' walks by staleness, not by id: it is a rotating refresh, not
  // a one-pass backfill, so it needs no cursor — a row it refreshes drops out
  // of the filter and goes to the back of the queue on its own.
  const order =
    mode === 'unenriched-newest'
      ? desc(listings.firstSeenAt)
      : mode === 'stale-price'
        ? sql`${listings.priceCheckedAt} ASC NULLS FIRST`
        : listings.id;
  const rows = await db
    .select({
      id: listings.id,
      source: listings.source,
      sourceId: listings.sourceId,
      url: listings.url,
      priceEur: listings.priceEur,
      year: listings.year,
      mileageKm: listings.mileageKm,
      fuel: listings.fuel,
      transmission: listings.transmission,
      region: listings.region,
    })
    .from(listings)
    .where(and(eq(listings.source, source), selectFilter, partitionFilter))
    .orderBy(order)
    .limit(size);

  return rows.map((r) => ({
    source: r.source as Source,
    sourceId: r.sourceId,
    url: r.url,
    makeSlug: null,
    modelSlug: null,
    priceEur: r.priceEur != null ? Number(r.priceEur) : null,
    year: r.year,
    mileageKm: r.mileageKm,
    fuel: r.fuel,
    transmission: r.transmission,
    region: r.region,
    rawTitle: null,
    // Expose the row id so the null-price backfill can advance its cursor.
    rawPayload: { __cursorId: r.id.toString() },
  }));
}

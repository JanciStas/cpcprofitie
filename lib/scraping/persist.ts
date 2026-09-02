// Persistence layer for scraper output. Batched upserts into the `listings`
// table and a row in `scrape_runs` per source per run. All operations are
// graceful no-ops when DATABASE_URL is unset so dev / preview builds don't
// crash.

import { and, eq, sql } from 'drizzle-orm';
import * as Sentry from '@sentry/nextjs';
import { getDb } from '@/lib/db';
import { isConnectionError, noteDbUnavailable } from '@/lib/db/errors';
import { hasDatabaseUrl } from '@/lib/db/url';
import {
  listingDetails,
  listingPhotos,
  listings,
  scrapeRuns,
  vehicleMakes,
  vehicleModels,
} from '@/lib/db/schema';
import { computeFingerprint } from '@/lib/dedup/fingerprint';
import { PRICE_MAX, PRICE_MIN } from '@/lib/analytics/quality';

/**
 * May a price read off a detail page replace the stored one?
 *
 * Every source already bounds-checks at parse time, but autobazar.eu only
 * enforces a floor, so the ceiling is repeated here: this value OVERWRITES the
 * stored price rather than filling a gap, and one misparsed decimal would
 * otherwise land straight in the reference medians.
 */
export function detailPriceIsUsable(priceEur: number | null | undefined): boolean {
  return priceEur != null && priceEur >= PRICE_MIN && priceEur <= PRICE_MAX;
}
import { resolveBrand } from './vehicle-dictionary';
import type { NormalizedDetail, NormalizedListing, ScrapeResult, Source } from './types';

export type UpsertCounts = {
  added: number;
  updated: number;
  skipped: number;
  /** Last error message if any chunk fail occurred — for diagnostics. */
  lastError?: string;
};

const BATCH_SIZE = 50;

function hasDb(): boolean {
  return hasDatabaseUrl();
}

// Process-local cache so each scrape run doesn't hammer the DB resolving the
// same make/model on every listing. Vercel cold starts reset it — fine, that
// just means the first listing per slug per cold start pays the round trip.
const makeIdCache = new Map<string, number>();
const modelIdCache = new Map<string, number>();

/** How many model lookups may be in flight at once. Kept under the postgres.js
 *  default pool size (max: 10) so a large batch queues in our code rather than
 *  saturating the pool. */
const MODEL_RESOLVE_CONCURRENCY = 8;

/** Test seam — clears the in-process lookup caches between tests. */
export function __resetModelCache(): void {
  makeIdCache.clear();
  modelIdCache.clear();
}

async function ensureMakeId(makeSlug: string): Promise<number | null> {
  // Second line of defence: ensureModelId already resolves the brand, but this
  // stays reachable and must never mint a make from an unrecognised token.
  if (!resolveBrand(makeSlug)) return null;
  const cached = makeIdCache.get(makeSlug);
  if (cached) return cached;
  try {
    const db = getDb();
    const found = await db
      .select({ id: vehicleMakes.id })
      .from(vehicleMakes)
      .where(eq(vehicleMakes.slug, makeSlug))
      .limit(1);
    if (found.length > 0) {
      makeIdCache.set(makeSlug, found[0]!.id);
      return found[0]!.id;
    }
    // Generate a stable-ish ID outside the seeded 1..15 range to avoid
    // collisions with curated seeds.
    const id = 1_000_000 + (hash32(makeSlug) & 0x7fffff);
    await db
      .insert(vehicleMakes)
      .values({ id, slug: makeSlug, name: toTitleCase(makeSlug) })
      .onConflictDoNothing({ target: vehicleMakes.slug });
    const refound = await db
      .select({ id: vehicleMakes.id })
      .from(vehicleMakes)
      .where(eq(vehicleMakes.slug, makeSlug))
      .limit(1);
    const finalId = refound[0]?.id ?? id;
    makeIdCache.set(makeSlug, finalId);
    return finalId;
  } catch (e) {
    if (isConnectionError(e)) throw noteDbUnavailable(e, { step: 'ensureMakeId', makeSlug });
    console.error('ensureMakeId_failed', {
      makeSlug,
      error: e instanceof Error ? e.message : e,
    });
    Sentry.captureException(e, {
      tags: { component: 'persist', step: 'ensureMakeId' },
      extra: { makeSlug },
    });
    return null;
  }
}

export async function ensureModelId(
  makeSlug: string | null,
  modelSlug: string | null,
): Promise<number | null> {
  if (!modelSlug || !makeSlug) return null;
  // Free text reaches this function, so the brand has to clear the dictionary
  // before anything is written. Without this the catalog grew makes called
  // `predam` and `rozpredam` straight out of listing titles.
  const brand = resolveBrand(makeSlug);
  if (!brand) return null;

  // Keyed by brand as well as model: slugs are bare ("golf", "octavia"), so the
  // same model slug can legitimately exist under two different makes.
  const key = `${brand}::${modelSlug}`;
  const cached = modelIdCache.get(key);
  if (cached) return cached;
  try {
    const db = getDb();
    const makeId = await ensureMakeId(brand);
    if (!makeId) return null;
    const found = await db
      .select({ id: vehicleModels.id })
      .from(vehicleModels)
      .where(and(eq(vehicleModels.makeId, makeId), eq(vehicleModels.slug, modelSlug)))
      .limit(1);
    if (found.length > 0) {
      modelIdCache.set(key, found[0]!.id);
      return found[0]!.id;
    }
    // The id is derived from a hash, so it can land on one an unrelated model
    // already holds — and onConflictDoNothing(make_id, slug) does not cover the
    // primary key, so that insert throws. It did: changing the hash input to
    // include the brand moved every id, and ~11 000 listings stopped resolving
    // because "audi/q7" kept colliding. Probe a free id instead of giving up.
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = 1_000_000 + (hash32(`${brand}-${modelSlug}-${attempt}`) & 0x7fffff);
      try {
        await db
          .insert(vehicleModels)
          .values({
            id,
            makeId,
            // The model's own name — never the listing title. Passing the title
            // through produced entries called "Predám Škoda Octavia 2.0 TDI".
            slug: modelSlug,
            name: toTitleCase(modelSlug),
          })
          .onConflictDoNothing({ target: [vehicleModels.makeId, vehicleModels.slug] });
      } catch (e) {
        if (isConnectionError(e)) throw noteDbUnavailable(e, { step: 'ensureModelId', modelSlug });
        continue; // id taken by an unrelated model — try the next candidate
      }
      const refound = await db
        .select({ id: vehicleModels.id })
        .from(vehicleModels)
        .where(and(eq(vehicleModels.makeId, makeId), eq(vehicleModels.slug, modelSlug)))
        .limit(1);
      const finalId = refound[0]?.id;
      if (finalId != null) {
        modelIdCache.set(key, finalId);
        return finalId;
      }
    }
    return null;
  } catch (e) {
    // An unreachable server is not a per-model problem: report it once and let
    // it abort the run instead of repeating for every remaining listing.
    if (isConnectionError(e)) {
      throw noteDbUnavailable(e, { step: 'ensureModelId', makeSlug, modelSlug });
    }
    console.error('ensureModelId_failed', {
      modelSlug,
      error: e instanceof Error ? e.message : e,
    });
    Sentry.captureException(e, {
      tags: { component: 'persist', step: 'ensureModelId' },
      extra: { makeSlug, modelSlug },
    });
    return null;
  }
}

/**
 * Resolve every distinct model slug in a batch to its ID.
 *
 * Previously this was `Promise.all(rows.map(...))`, which fired one lookup per
 * listing with no concurrency cap — hundreds of simultaneous queries against a
 * 10-connection pool, and hundreds of duplicate lookups for the same slug. It
 * also meant an outage produced one error per listing (CPCPROFIT-8).
 *
 * Deduplicating first cuts the query count by roughly an order of magnitude,
 * and the bounded workers let an outage stop the batch after the first failure
 * instead of after the last.
 */
async function resolveModelIds(rows: NormalizedListing[]): Promise<Map<string, number | null>> {
  const wanted = new Map<string, { makeSlug: string | null; displayName: string | null }>();
  for (const r of rows) {
    if (!r.modelSlug) continue;
    const seen = wanted.get(r.modelSlug);
    // Prefer whichever row actually parsed a make: ensureModelId bails without
    // one, so letting a make-less row win would drop model_id for every sibling
    // sharing the slug. autobazar.eu parses make and model independently, so a
    // batch really does contain both shapes in arbitrary order.
    if (seen && (seen.makeSlug || !r.makeSlug)) continue;
    wanted.set(r.modelSlug, {
      makeSlug: r.makeSlug,
      displayName: r.rawTitle ?? seen?.displayName ?? null,
    });
  }

  const queue = [...wanted.entries()];
  const resolved = new Map<string, number | null>();
  let cursor = 0;

  // Scoped to THIS call on purpose. A module-level "db is down" flag would
  // outlive the outage and turn every later batch in a warm lambda into a
  // silent no-op that writes null model_ids and reports success.
  let outage: unknown;

  async function worker(): Promise<void> {
    while (cursor < queue.length && outage === undefined) {
      const [modelSlug, meta] = queue[cursor++]!;
      try {
        resolved.set(modelSlug, await ensureModelId(meta.makeSlug, modelSlug));
      } catch (e) {
        // ensureModelId only throws for an outage; everything else returns null.
        // Stop the siblings rather than let them pile on the same dead server.
        outage = e;
        return;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MODEL_RESOLVE_CONCURRENCY, queue.length) }, () => worker()),
  );
  if (outage !== undefined) throw outage;
  // Belt and braces: a partially filled map would read downstream as "these
  // slugs legitimately have no model", which is exactly the silent data loss
  // this whole change exists to prevent.
  if (resolved.size !== queue.length) {
    throw noteDbUnavailable(
      new Error(`model resolution incomplete: ${resolved.size}/${queue.length}`),
      { step: 'resolveModelIds' },
    );
  }
  return resolved;
}

export async function upsertListings(rows: NormalizedListing[]): Promise<UpsertCounts> {
  if (rows.length === 0) return { added: 0, updated: 0, skipped: 0 };
  if (!hasDb()) {
    return { added: 0, updated: 0, skipped: rows.length };
  }
  const db = getDb();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let lastError: string | undefined;

  // Resolve all model IDs up front so the batch insert is one round trip per
  // chunk. Deduplicated and concurrency-capped — see resolveModelIds above.
  const modelIds = await resolveModelIds(rows);
  const resolved = rows.map((r) => {
    if (!r.sourceId || !r.url) return null;
    const modelId = (r.modelSlug ? modelIds.get(r.modelSlug) : null) ?? null;
    // A listing page carries no seller name and no photo we can attribute to
    // the car, so this is the weakest form of the fingerprint. It is null far
    // more often than not, and that is the point: computeFingerprint refuses
    // to hash a listing that cannot be told apart from another car of the same
    // model, rather than handing back a value they would all share.
    //
    // refreshFingerprints() recomputes from the enriched row later, where a
    // seller name and a real photo identity may exist. Nothing here needs to
    // guess ahead of that.
    const fingerprint = computeFingerprint({
      source: r.source,
      sourceId: r.sourceId,
      makeSlug: r.makeSlug,
      modelSlug: r.modelSlug,
      year: r.year,
      mileageKm: r.mileageKm,
      region: r.region,
      sellerName: null,
      firstPhotoUrl: null,
    });
    return {
      source: r.source,
      sourceId: r.sourceId,
      modelId,
      priceEur: r.priceEur != null ? String(r.priceEur) : null,
      year: r.year,
      mileageKm: r.mileageKm,
      fuel: r.fuel,
      transmission: r.transmission,
      region: r.region,
      country: r.country ?? null,
      locality: r.locality ?? null,
      rawTitle: r.rawTitle,
      url: r.url,
      rawJson: r.rawPayload,
      fingerprint,
      // Stamped on insert too, not only on update. A first scrape reads the
      // price like any other, so leaving it null made every newly discovered
      // listing look unverified — 12 000 arrived from bazoš's deeper pages in
      // one night and dragged that source's freshness to 71%, firing an alert
      // about a crawler that was in fact working perfectly.
      //
      // Not the same question as first_seen_alive_at, which is deliberately
      // absent here: a first sighting is not evidence the advert is live, but
      // it IS evidence of what its price said.
      priceCheckedAt: r.priceEur != null ? new Date() : null,
      viewCount: r.viewCount ?? null,
      isFeatured: r.isFeatured === true,
      sellerPhone: r.sellerPhone ?? null,
    };
  });
  const resolvedRows = resolved.filter((r): r is NonNullable<typeof r> => r !== null);
  // Deduplicate by (source, sourceId): some sites return the same listings
  // across "different" paginated pages (e.g. autobazar.sk /inzeraty/?page=N
  // serves a server-rendered featured panel that ignores `page`). Postgres
  // ON CONFLICT cannot affect the same target row twice in one statement, so
  // duplicates within a batch would cause the whole chunk to fail.
  const seenKey = new Set<string>();
  const validRows: typeof resolvedRows = [];
  for (const r of resolvedRows) {
    const key = `${r.source}::${r.sourceId}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    validRows.push(r);
  }
  skipped += rows.length - validRows.length;

  for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
    const chunk = validRows.slice(i, i + BATCH_SIZE);
    try {
      const result = await db
        .insert(listings)
        .values(chunk)
        .onConflictDoUpdate({
          target: [listings.source, listings.sourceId],
          set: {
            // Price is the ONE field here that is deliberately overwritten,
            // because it is the one fact that genuinely changes: a seller
            // dropping the price is the single event this product exists to
            // detect. Coalescing it would pin a stale asking price on a
            // "Cena dohodou" advert for ever, and a phantom price is not a
            // missing data point — it is a wrong one, in the median of the
            // exact cohort someone is about to buy in. Measured cost of
            // leaving it alone: 16 rows.
            priceEur: sql`excluded.price_eur`,
            // Everything below describes the car, not the seller's intent, and
            // none of it changes between two reads of the same advert. A null
            // from a re-scrape therefore carries no information, and writing it
            // destroys what an earlier detail-page read established.
            //
            // This is not a new convention: viewCount and sellerPhone below
            // already coalesce, and bazos-sk.ts:81 documents the reason. Year
            // and mileage were simply missed — and once the scrape cron began
            // rotating through the whole corpus instead of re-reading the same
            // 30 pages, that oversight started erasing about 1 800 recovered
            // years and 1 400 mileages every few hours.
            year: sql`coalesce(excluded.year, ${listings.year})`,
            mileageKm: sql`coalesce(excluded.mileage_km, ${listings.mileageKm})`,
            fuel: sql`coalesce(excluded.fuel, ${listings.fuel})`,
            transmission: sql`coalesce(excluded.transmission, ${listings.transmission})`,
            // bazos-sk.ts:99 hardcodes region: null — its list page has no
            // location at all, so this was wiping region for 99.4% of bazoš
            // listings on every pass.
            region: sql`coalesce(excluded.region, ${listings.region})`,
            // Same rule for country: a scrape that could not establish it
            // must not erase one that could. Never coalesce the other way —
            // an advert does not move between countries.
            country: sql`coalesce(excluded.country, ${listings.country})`,
            locality: sql`coalesce(excluded.locality, ${listings.locality})`,
            // Also guards against ensureModelId returning null on a transient
            // DB error, which would otherwise turn a blip into permanent loss.
            // Cannot resurrect a model the catalog merge cleared: the stored
            // value is NULL there, so coalesce falls through to the new one.
            modelId: sql`coalesce(excluded.model_id, ${listings.modelId})`,
            // Coalesce so a rescrape that fails to parse a title doesn't wipe
            // a previously good one. New non-null titles still win on update.
            rawTitle: sql`coalesce(excluded.raw_title, ${listings.rawTitle})`,
            url: sql`excluded.url`,
            rawJson: sql`excluded.raw_json`,
            lastSeenAt: sql`now()`,
            // The freshness stamp, and the only place besides the detail
            // refresh that is allowed to set it. A list page carries a price,
            // so reaching this line means the price was genuinely re-read.
            // last_seen_at cannot serve this purpose: check-removed bumps it
            // after a HEAD request, which reads no price at all.
            priceCheckedAt: sql`now()`,
            // Evidence the advert really exists. Only in the UPDATE branch,
            // never in the insert: a first sighting can come from a stale
            // index, and 4 000+ of our "sales" were listings that were already
            // dead the first time we looked. Seeing it AGAIN, later, is the
            // proof. coalesce so the first such sighting is the one kept.
            firstSeenAliveAt: sql`coalesce(${listings.firstSeenAliveAt}, now())`,
            // Don't clobber a stronger fingerprint (computed post-enrichment)
            // with the weaker upsert-time one. Only set it when NULL.
            fingerprint: sql`coalesce(${listings.fingerprint}, excluded.fingerprint)`,
            // Engagement signals: view_count uses fresh non-null (counters go up),
            // is_featured is sticky-true (OR), seller_phone keeps first non-null.
            viewCount: sql`coalesce(excluded.view_count, ${listings.viewCount})`,
            isFeatured: sql`(${listings.isFeatured} OR excluded.is_featured)`,
            sellerPhone: sql`coalesce(${listings.sellerPhone}, excluded.seller_phone)`,
          },
        })
        .returning({
          id: listings.id,
          source: listings.source,
          sourceId: listings.sourceId,
          inserted: sql<boolean>`(xmax = 0)`,
        });
      for (const row of result) {
        if (row.inserted) added++;
        else updated++;
      }

      // Persist list-page thumbnails captured in rawPayload.thumbnailUrl.
      // ON CONFLICT DO NOTHING keeps existing rows — detail enrichment can
      // later replace the whole album with delete+insert.
      const thumbRows: Array<{ listingId: bigint; position: number; url: string }> = [];
      for (const inserted of result) {
        const original = chunk.find(
          (c) => c.source === inserted.source && c.sourceId === inserted.sourceId,
        );
        const thumb = original?.rawJson?.thumbnailUrl;
        if (typeof thumb !== 'string' || thumb.length === 0) continue;
        thumbRows.push({ listingId: inserted.id, position: 1, url: thumb.slice(0, 2000) });
      }
      if (thumbRows.length > 0) {
        await db
          .insert(listingPhotos)
          .values(thumbRows)
          .onConflictDoNothing({ target: [listingPhotos.listingId, listingPhotos.position] });
      }
    } catch (e) {
      // Otherwise an outage silently inflates `skipped` and the run "succeeds".
      if (isConnectionError(e)) throw noteDbUnavailable(e, { step: 'upsertListings' });
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error('listings_batch_upsert_failed', {
        chunkSize: chunk.length,
        firstSourceId: chunk[0]?.sourceId,
        firstSource: chunk[0]?.source,
        firstRow: JSON.stringify(chunk[0]),
        error: errMsg,
        stack: e instanceof Error ? e.stack?.slice(0, 500) : undefined,
      });
      // Surface DB-level failures (schema drift, FK violation, etc.) to Sentry.
      // Without this they hide as "skipped" counts and never alert.
      Sentry.captureException(e, {
        tags: { component: 'persist', step: 'upsertListings' },
        extra: { chunkSize: chunk.length, firstSource: chunk[0]?.source },
      });
      skipped += chunk.length;
      lastError = errMsg;
    }
  }
  return { added, updated, skipped, lastError };
}

/**
 * Open a run row before the work starts, so a run that never finishes still
 * leaves evidence.
 *
 * The old recordScrapeRun wrote its row only after the scrape, the upsert and
 * the enrichment had all completed. When the platform killed the function at
 * its 300s ceiling — which it was doing daily, to whichever source came last in
 * the loop — no row was written, no error was raised, and the source simply
 * vanished from the day with nothing anywhere to say so. bazos.sk went missing
 * from two runs out of three and the only way to notice was to count listings
 * by hand.
 *
 * A `running` row older than a few minutes is now an unambiguous "a function
 * died here", which is a thing that can be alerted on.
 */
export async function openScrapeRun(
  source: Source,
  intent: { startPage: number; endPage: number; cycleNo?: number },
): Promise<bigint | null> {
  if (!hasDb()) return null;
  try {
    const db = getDb();
    const rows = await db
      .insert(scrapeRuns)
      .values({
        source,
        status: 'running',
        startPage: intent.startPage,
        endPage: intent.endPage,
        cycleNo: intent.cycleNo ?? null,
      })
      .returning({ id: scrapeRuns.id });
    return rows[0]?.id ?? null;
  } catch (e) {
    if (isConnectionError(e)) throw noteDbUnavailable(e, { step: 'openScrapeRun', source });
    console.error('scrape_run_open_failed', e instanceof Error ? e.message : e);
    Sentry.captureException(e, {
      tags: { component: 'persist', step: 'openScrapeRun' },
      extra: { source },
    });
    return null;
  }
}

/**
 * Close a run opened by openScrapeRun with what it actually covered.
 *
 * `status` deliberately ignores 404s. Once the rotation walks a source to its
 * end, reaching the end is the normal outcome of a healthy run — treating it as
 * a failure would turn the status column into noise within a week, precisely
 * when it starts being the thing that tells us a source is broken.
 */
export async function closeScrapeRun(
  runId: bigint | null,
  source: Source,
  result: ScrapeResult,
  counts: UpsertCounts,
  coverage: {
    startPage: number;
    endPage: number;
    pagesOk: number;
    pagesEmpty: number;
    pagesNotFound: number;
    pagesError: number;
    cycleNo?: number;
    stoppedReason?: string;
  },
): Promise<void> {
  if (!hasDb()) return;
  try {
    const db = getDb();
    const combinedErrors: string[] = [];
    if (result.errors.length > 0) combinedErrors.push(...result.errors.slice(0, 5));
    if (counts.lastError) combinedErrors.push(`upsert: ${counts.lastError}`);
    const failed = coverage.pagesError > 0 || Boolean(counts.lastError);

    const values = {
      status: (failed ? 'failed' : 'succeeded') as 'failed' | 'succeeded',
      finishedAt: result.finishedAt,
      listingsAdded: counts.added,
      listingsUpdated: counts.updated,
      errorMessage: combinedErrors.length > 0 ? combinedErrors.join('; ') : null,
      startPage: coverage.startPage,
      endPage: coverage.endPage,
      pagesOk: coverage.pagesOk,
      pagesEmpty: coverage.pagesEmpty,
      pagesNotFound: coverage.pagesNotFound,
      pagesError: coverage.pagesError,
      cycleNo: coverage.cycleNo ?? null,
      stoppedReason: coverage.stoppedReason ?? null,
    };

    if (runId == null) {
      // openScrapeRun could not write (no DB at the time, or it failed). Still
      // record the outcome rather than losing the run entirely.
      await db.insert(scrapeRuns).values({ source, startedAt: result.startedAt, ...values });
      return;
    }
    await db.update(scrapeRuns).set(values).where(eq(scrapeRuns.id, runId));
  } catch (e) {
    if (isConnectionError(e)) throw noteDbUnavailable(e, { step: 'closeScrapeRun', source });
    console.error('scrape_run_close_failed', e instanceof Error ? e.message : e);
    // A lost audit trail hides schema-drift-style bugs, so it pages.
    Sentry.captureException(e, {
      tags: { component: 'persist', step: 'closeScrapeRun' },
      extra: { source },
    });
  }
}

// ─── Detail enrichment persistence ──────────────────────────────────────────

export type DetailUpsertCounts = {
  detailsUpserted: number;
  photosInserted: number;
  skipped: number;
};

/** Resolve a (source, sourceId) pair to the listings.id. Cached per-process. */
const listingIdCache = new Map<string, bigint>();

function listingKey(source: Source, sourceId: string): string {
  return `${source}::${sourceId}`;
}

async function resolveListingId(source: Source, sourceId: string): Promise<bigint | null> {
  const key = listingKey(source, sourceId);
  const cached = listingIdCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const db = getDb();
    const rows = await db
      .select({ id: listings.id })
      .from(listings)
      .where(and(eq(listings.source, source), eq(listings.sourceId, sourceId)))
      .limit(1);
    const id = rows[0]?.id ?? null;
    if (id !== null) listingIdCache.set(key, id);
    return id;
  } catch (e) {
    if (isConnectionError(e)) throw noteDbUnavailable(e, { step: 'resolveListingId', source });
    console.error('resolveListingId_failed', {
      source,
      sourceId,
      error: e instanceof Error ? e.message : e,
    });
    return null;
  }
}

export async function persistDetails(details: NormalizedDetail[]): Promise<DetailUpsertCounts> {
  if (details.length === 0) return { detailsUpserted: 0, photosInserted: 0, skipped: 0 };
  if (!hasDb()) {
    return { detailsUpserted: 0, photosInserted: 0, skipped: details.length };
  }
  const db = getDb();
  let detailsUpserted = 0;
  let photosInserted = 0;
  let skipped = 0;

  for (const d of details) {
    const listingId = await resolveListingId(d.source, d.sourceId);
    if (listingId === null) {
      skipped++;
      continue;
    }

    // Gone (404/410/redirect): mark the listing removed so it exits the active
    // enrichment / null-price pools, and DON'T overwrite an existing enriched
    // detail row with the empty tombstone fields (onConflictDoNothing
    // preserves a previously-scraped seller/VIN/equipment). A fresh gone row
    // still gets a tombstone detail so unenriched-mode notExists stops picking.
    //
    // 403 is deliberately NOT in that list any more; see enrich.ts. The
    // tombstone carries the reason enrich determined, because '[GONE]' on its
    // own could not be audited: when 3 676 bazos rows went gone in one day
    // there was no way to ask which were real. Readers match '[GONE%'.
    if (d.gone) {
      try {
        await db.execute(sql`
          UPDATE listings SET removed_at = coalesce(removed_at, now()) WHERE id = ${listingId}
        `);
        await db
          .insert(listingDetails)
          .values({
            listingId,
            description: d.description?.startsWith('[GONE') ? d.description : '[GONE]',
            equipment: [],
          })
          .onConflictDoNothing({ target: listingDetails.listingId });
        detailsUpserted++;
      } catch (e) {
        if (isConnectionError(e)) throw noteDbUnavailable(e, { step: 'persistDetails.gone' });
        console.error('persistDetails_gone_failed', {
          source: d.source,
          sourceId: d.sourceId,
          error: e instanceof Error ? e.message : e,
        });
        Sentry.captureException(e, {
          tags: { component: 'persist', step: 'persistDetails.gone' },
          extra: { source: d.source, sourceId: d.sourceId },
        });
        skipped++;
      }
      continue;
    }

    try {
      // A detail page that parsed is the strongest evidence we have that the
      // advert exists. Stamped before the detail upsert so a failure there
      // still leaves the liveness fact recorded — it is true either way.
      await db.execute(sql`
        UPDATE listings SET first_seen_alive_at = coalesce(first_seen_alive_at, now())
        WHERE id = ${listingId}
      `);
      await db
        .insert(listingDetails)
        .values({
          listingId,
          bodyType: clamp(d.bodyType, 32),
          colorExterior: clamp(d.colorExterior, 64),
          colorInterior: clamp(d.colorInterior, 64),
          powerKw: d.powerKw,
          engineCcm: d.engineCcm,
          vin: clamp(d.vin, 17),
          sellerType: d.sellerType,
          sellerName: d.sellerName,
          description: d.description,
          equipment: d.equipment,
        })
        .onConflictDoUpdate({
          target: listingDetails.listingId,
          set: {
            bodyType: sql`excluded.body_type`,
            colorExterior: sql`excluded.color_exterior`,
            colorInterior: sql`excluded.color_interior`,
            powerKw: sql`excluded.power_kw`,
            engineCcm: sql`excluded.engine_ccm`,
            vin: sql`excluded.vin`,
            sellerType: sql`excluded.seller_type`,
            sellerName: sql`excluded.seller_name`,
            description: sql`excluded.description`,
            equipment: sql`excluded.equipment`,
            detailedAt: sql`now()`,
          },
        });
      detailsUpserted++;

      if (d.photos.length > 0) {
        // Replace photos atomically: delete + insert in one transaction so a
        // mid-insert failure can't leave the listing photo-less.
        const photoRows = d.photos.slice(0, 100).map((url, i) => ({
          listingId,
          position: i + 1,
          url: url.slice(0, 2000),
        }));
        await db.transaction(async (tx) => {
          await tx.delete(listingPhotos).where(eq(listingPhotos.listingId, listingId));
          if (photoRows.length > 0) {
            await tx.insert(listingPhotos).values(photoRows);
          }
        });
        photosInserted += photoRows.length;
      }

      // Detail page typically has more accurate year/km/region/fuel than the
      // list card. Patch any NULL columns on listings — never overwrite a
      // non-null value because the list card might be the more trustworthy
      // source for that field (e.g. price is on every list card).
      const set: Record<string, unknown> = {};
      if (d.listingOverrides) {
        const o = d.listingOverrides;
        if (o.year != null) set.year = sql`coalesce(${listings.year}, ${o.year})`;
        if (o.mileageKm != null)
          set.mileageKm = sql`coalesce(${listings.mileageKm}, ${o.mileageKm})`;
        if (o.fuel != null) set.fuel = sql`coalesce(${listings.fuel}, ${o.fuel})`;
        if (o.transmission != null)
          set.transmission = sql`coalesce(${listings.transmission}, ${o.transmission})`;
        // Fills a gap, and additionally corrects a country prefix the stored
        // value gets wrong. Plain coalesce was not enough: once the detail page
        // could establish country='CZ', 206 rows kept the 'SK-Brno' the list
        // parser had written, because coalesce keeps whatever is already there.
        // The town itself is left alone — only the two-letter market marker is
        // restamped, and only when it disagrees.
        if (o.region != null)
          set.region = sql`CASE
            WHEN ${listings.region} IS NULL THEN ${o.region}
            WHEN left(${listings.region}, 2) <> left(${o.region}, 2) THEN ${o.region}
            ELSE ${listings.region}
          END`;
        if (o.locality != null)
          set.locality = sql`coalesce(${listings.locality}, ${o.locality})`;
        if (o.country != null)
          set.country = sql`coalesce(${listings.country}, ${o.country})`;
        // The only override that overwrites instead of filling a gap. Every
        // other field here is "the detail page knows more than the list card";
        // this one is "the detail page contradicts an assumption we made from
        // the domain name", and leaving country='SK' on a car the seller filed
        // under Zahraničie would keep a foreign price in the Slovak reference.
        if (o.foreignLocality === true) set.country = sql`NULL`;
        if (detailPriceIsUsable(o.priceEur)) {
          // OVERWRITE, not fill. This is the one field on a detail page that is
          // a fresh measurement rather than a gap-filler, and treating it as a
          // gap-filler had a consequence nobody costed:
          //
          // bazos.sk repeats its last page beyond a certain depth (offsets
          // 60 000 and 120 000 return the identical twenty adverts), so the
          // catalogue walk reaches about 20 000 of its 60 000 active listings.
          // Roughly 40 000 bazos prices are therefore unreachable by the walk,
          // and the detail pass — which goes by id and has no depth ceiling —
          // was the only path left. With coalesce it refreshed neither the
          // price nor its timestamp, so those prices were frozen for good while
          // still counting in the reference medians.
          //
          // Safe to overwrite because every source validates the value at parse
          // time against the same bounds and anchors on the same element the
          // list parser uses; the guard above repeats the bounds so the one
          // source with no upper limit cannot slip a decimal past us.
          set.priceEur = sql`${String(o.priceEur)}`;
          // Migration 0012 claimed this path stamped the column. It did not,
          // and then coalesce meant it still did not for any row that already
          // had a stamp — which is every row the walk had ever seen.
          set.priceCheckedAt = sql`now()`;
        }
      }
      // Identity backfill for title-less/model-less stubs: resolve model_id the
      // same way list scraping does and patch model_id / raw_title only when
      // NULL. Same coalesce-fill-only guarantee as the field overrides.
      if (d.identity) {
        if (d.identity.rawTitle) {
          set.rawTitle = sql`coalesce(${listings.rawTitle}, ${d.identity.rawTitle})`;
        }
        const modelId = await ensureModelId(d.identity.makeSlug, d.identity.modelSlug);
        if (modelId != null) {
          set.modelId = sql`coalesce(${listings.modelId}, ${modelId})`;
        }
      }
      if (Object.keys(set).length > 0) {
        await db.update(listings).set(set).where(eq(listings.id, listingId));
      }
    } catch (e) {
      if (isConnectionError(e)) throw noteDbUnavailable(e, { step: 'persistDetails.row' });
      console.error('persistDetails_row_failed', {
        source: d.source,
        sourceId: d.sourceId,
        error: e instanceof Error ? e.message : e,
      });
      // These two were the only paths in this file that stayed off Sentry, which
      // is why a 100% write-failure rate went unnoticed for hours.
      Sentry.captureException(e, {
        tags: { component: 'persist', step: 'persistDetails.row' },
        extra: { source: d.source, sourceId: d.sourceId },
      });
      skipped++;
    }
  }
  return { detailsUpserted, photosInserted, skipped };
}

/** Guards the varchar widths in lib/db/schema.ts. A single over-long value used
 *  to fail the insert and lose the whole detail row — the same defence already
 *  applied to description and photo URLs. Dropping the value beats truncating
 *  it: a clipped sentence in body_type is worse than an empty column. */
function clamp(value: string | null | undefined, maxLen: number): string | null {
  if (value == null) return null;
  return value.length <= maxLen ? value : null;
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function toTitleCase(slug: string): string {
  return slug
    .split('-')
    .map((p) => (p.length > 0 ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join(' ');
}

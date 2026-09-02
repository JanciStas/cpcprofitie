// Second-pass enrichment driver. Takes the listing-page output and, for each
// row, fetches the listing's detail URL and runs the source's
// `parseDetailPage`. Sources without a `parseDetailPage` are skipped.

import * as Sentry from '@sentry/nextjs';
import { isAllowed, parseRobotsTxt, crawlDelayFor } from './robots';
import { ScrapeForbiddenError, USER_AGENT, type ScraperSource } from './sources/source-interface';
import type { NormalizedDetail, NormalizedListing } from './types';

export type EnrichOptions = {
  /** Hard cap on how many detail pages to fetch per run. */
  limit?: number;
  /** Backoff between requests in ms. Robots Crawl-delay wins if larger. */
  delayMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Ceiling on how much of one batch may report gone before we disbelieve it.
 *
 * Measured against the real distribution: on a normal day a batch reports low
 * single-digit percentages gone. The 25 August bazos episode was effectively
 * 100%.
 */
export const MAX_GONE_SHARE = 0.2;

/**
 * How many gone pages a batch needs before the share above means anything.
 *
 * Without a floor the ratio fires on noise: one dead listing out of three is
 * 33%, and a normal enrichment batch that happens to be short would abort on a
 * single genuine 404. The episode this guard exists to catch was 3 676 rows, so
 * a floor here costs nothing real.
 */
export const MIN_GONE_FOR_GUARD = 20;

/** Thrown when a batch reports so many gone pages that the source, not the
 *  market, is the likely explanation. Callers should fail the run. */
export class MassGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MassGoneError';
  }
}

export type EnrichResult = {
  details: NormalizedDetail[];
  fetched: number;
  errors: string[];
  /** How many of `fetched` reported gone. Exposed so a caller that batches can
   *  apply the ceiling across the whole run — see exceedsGoneCeiling. */
  gone: number;
};

/**
 * Is this share of gone pages beyond belief?
 *
 * Exported because the in-batch check below is NOT the one that protects
 * production. The cron drives this function in batches of ten, so `goneCount`
 * could never reach MIN_GONE_FOR_GUARD (20) and MassGoneError was unreachable
 * from the only caller that matters — the guard existed, was tested, and did
 * nothing where the 25 August episode actually happened. The caller now
 * accumulates across batches and applies the same predicate.
 */
export function exceedsGoneCeiling(goneCount: number, fetched: number): boolean {
  return goneCount >= MIN_GONE_FOR_GUARD && goneCount > fetched * MAX_GONE_SHARE;
}

// Re-uses the per-host robots cache by re-deriving from the URL. To keep this
// module decoupled from scrape.ts the cache lives there; here we just call
// `isAllowed` against the parsed robots body fetched on demand.
const robotsBodyCacheByHost = new Map<string, { fetchedAt: number; body: string }>();
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchRobots(baseUrl: string, f: typeof fetch): Promise<string> {
  const host = new URL(baseUrl).host;
  const now = Date.now();
  const cached = robotsBodyCacheByHost.get(host);
  if (cached && now - cached.fetchedAt < ROBOTS_TTL_MS) return cached.body;
  try {
    const res = await f(`${baseUrl}/robots.txt`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
    });
    const body = res.ok ? await res.text() : '';
    robotsBodyCacheByHost.set(host, { fetchedAt: now, body });
    return body;
  } catch (e) {
    // Permissive cache so a DNS hiccup doesn't disable crawling, but alert
    // so we know robots.txt is effectively missing for this host.
    Sentry.captureException(e, {
      tags: { component: 'enrich', step: 'fetchRobots' },
      extra: { host },
    });
    robotsBodyCacheByHost.set(host, { fetchedAt: now, body: '' });
    return '';
  }
}

export function __resetEnrichRobotsCache(): void {
  robotsBodyCacheByHost.clear();
}

export async function runEnrichment(
  source: ScraperSource,
  listings: NormalizedListing[],
  opts: EnrichOptions = {},
): Promise<EnrichResult> {
  if (!source.detailUrl || !source.parseDetailPage) {
    return {
      details: [],
      fetched: 0,
      errors: ['source has no detailUrl/parseDetailPage'],
      gone: 0,
    };
  }
  const limit = opts.limit ?? 30;
  const f = opts.fetchImpl ?? fetch;
  const candidates = listings.slice(0, limit);
  const details: NormalizedDetail[] = [];
  const errors: string[] = [];

  const robotsBody = await fetchRobots(source.baseUrl, f);
  const robots = parseRobotsTxt(robotsBody);
  const baselineDelay = crawlDelayFor(robots, USER_AGENT);
  const delay = baselineDelay ? Math.max(opts.delayMs ?? 0, baselineDelay * 1000) : (opts.delayMs ?? 1500);

  let fetched = 0;
  let goneCount = 0;
  for (const listing of candidates) {
    const url = source.detailUrl!(listing);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      errors.push(`bad detail URL for ${listing.sourceId}: ${url}`);
      continue;
    }
    const pathWithQuery = parsed.pathname + parsed.search;
    if (!isAllowed(robots, USER_AGENT, pathWithQuery)) {
      throw new ScrapeForbiddenError(
        `${source.id} robots.txt disallows detail ${pathWithQuery} for ${USER_AGENT}`,
      );
    }
    try {
      const res = await f(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      });
      fetched++;
      // Deleted listings often 200-redirect to a search/home page (e.g.
      // bazos.sk /inzerat/<id>/ → /inzeraty/<slug>/, autobazar.sk → a listing
      // grid). Parsing that landing page would scrape ANOTHER car's price into
      // this listing. Detect generically: a redirect whose final URL no longer
      // contains this listing's sourceId is gone. (Canonicalizing redirects —
      // trailing slash, www — keep the id, so they're not flagged.)
      const finalUrl = res.url || url;
      const goneViaRedirect =
        res.ok && Boolean(res.url) && res.url !== url && !finalUrl.includes(listing.sourceId);
      if (!res.ok || goneViaRedirect) {
        const status = goneViaRedirect ? 'redirect→gone' : `HTTP ${res.status}`;
        errors.push(`${listing.sourceId}: ${status}`);
        // Tombstone permanently-gone listings so they exit the enrichment /
        // null-price pools. `gone: true` tells persistDetails to mark
        // removed_at and NOT wipe an existing enriched detail row with these
        // empty fields.
        //
        // 403 used to be in this list, described in this very comment as
        // "source blocks us" and then treated as a deletion anyway. Being
        // blocked says nothing about the car: on 25 August that reading marked
        // 3 676 bazos listings gone in a single day, every one of them fed
        // straight into the sold detector. A block is our problem and belongs
        // in errors, so the run reports it and the listing is left alone.
        //
        // The reason is carried in the tombstone because '[GONE]' alone could
        // not be audited after the fact -- there was no way to ask which of
        // those 3 676 were real. Readers must match '[GONE%', not '[GONE]'.
        if (goneViaRedirect || res.status === 404 || res.status === 410) {
          const reason = goneViaRedirect ? 'redirect' : String(res.status);
          goneCount++;
          details.push({
            source: source.id,
            sourceId: listing.sourceId,
            gone: true,
            photos: [],
            description: `[GONE:${reason}]`,
            vin: null,
            bodyType: null,
            colorExterior: null,
            colorInterior: null,
            powerKw: null,
            engineCcm: null,
            sellerType: null,
            sellerName: null,
            equipment: [],
          });
        }
        continue;
      }
      const html = await res.text();
      details.push(source.parseDetailPage!(html, listing));
    } catch (e) {
      errors.push(`${listing.sourceId}: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
    if (fetched < candidates.length) await sleep(delay);
  }

  // A batch that is mostly gone is our failure, not the market's. Listings do
  // not vanish in bulk; rate limits, a moved DOM and an expired session all do
  // exactly this, and each one would otherwise be written to removed_at and
  // read back as demand. Refusing the whole batch is the cheap direction to be
  // wrong in: the rows are re-read on the next pass, whereas removed_at is
  // acted on by the sold detector before anyone notices.
  if (exceedsGoneCeiling(goneCount, fetched)) {
    throw new MassGoneError(
      `${source.id}: ${goneCount}/${fetched} detail pages reported gone, ` +
        `over the ${Math.round(MAX_GONE_SHARE * 100)}% ceiling -- refusing the batch`,
    );
  }

  return { details, fetched, errors, gone: goneCount };
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

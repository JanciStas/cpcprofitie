// Generic scrape driver. Per-source plugins (lib/scraping/sources/*.ts) supply
// page URLs and parsing; this module owns robots.txt fetch+cache, per-page
// allow-checks, the fetch loop, crawl-delay, and error aggregation. Add a new
// source by implementing ScraperSource and registering it in registry.ts.

import { crawlDelayFor, isAllowed, parseRobotsTxt } from './robots';
import { ScrapeForbiddenError, USER_AGENT, type ScraperSource } from './sources/source-interface';
import type { NormalizedListing, PageOutcome, ScrapeResult, Source } from './types';

export type RunScrapeOptions = {
  pages?: number;
  fetchImpl?: typeof fetch;
  /** Minimum backoff between pages in ms. Robots-supplied Crawl-delay wins if larger. */
  delayMs?: number;
  /** 1-based page index to start at. Lets callers walk a deep paginated source
   *  across multiple invocations (bazos.sk has ~12k pages of 20 listings each). */
  startPage?: number;
  /**
   * Epoch ms after which the walk stops early and reports what it covered.
   *
   * Without this the platform kills the function mid-page and the run leaves
   * nothing behind — no row, no error, no trace. Stopping on our own terms lets
   * the cursor advance by the pages actually persisted.
   */
  deadline?: number;
  /**
   * Consecutive empty/404 pages that mean the source has run out, rather than
   * one short brand in a ragged sequence.
   */
  endOfCatalogStreak?: number;
};

type RobotsCacheEntry = {
  fetchedAt: number;
  perPath: (path: string) => boolean;
  crawlDelaySec?: number;
};

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

// One robots cache per source — both bazos.sk and sauto.cz live on different
// origins so their robots.txt is fetched independently.
const robotsCacheByHost = new Map<string, RobotsCacheEntry>();
const robotsInflightByHost = new Map<string, Promise<RobotsCacheEntry>>();

async function ensureRobots(baseUrl: string, f: typeof fetch): Promise<RobotsCacheEntry> {
  const host = new URL(baseUrl).host;
  const now = Date.now();
  const cached = robotsCacheByHost.get(host);
  if (cached && now - cached.fetchedAt < ROBOTS_TTL_MS) return cached;
  const inflight = robotsInflightByHost.get(host);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const res = await f(`${baseUrl}/robots.txt`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
      });
      if (!res.ok) {
        const entry: RobotsCacheEntry = { fetchedAt: now, perPath: () => true };
        robotsCacheByHost.set(host, entry);
        return entry;
      }
      const body = await res.text();
      const robots = parseRobotsTxt(body);
      const entry: RobotsCacheEntry = {
        fetchedAt: now,
        perPath: (path) => isAllowed(robots, USER_AGENT, path),
        crawlDelaySec: crawlDelayFor(robots, USER_AGENT),
      };
      robotsCacheByHost.set(host, entry);
      return entry;
    } catch {
      // Fail-open on robots.txt fetch errors; we still ship a UA + crawl-delay.
      const entry: RobotsCacheEntry = { fetchedAt: now, perPath: () => true };
      robotsCacheByHost.set(host, entry);
      return entry;
    } finally {
      robotsInflightByHost.delete(host);
    }
  })();
  robotsInflightByHost.set(host, promise);
  return promise;
}

/** Test seam — clears robots cache for all hosts. */
export function __resetRobotsCache(): void {
  robotsCacheByHost.clear();
  robotsInflightByHost.clear();
}

export async function runScrape(
  source: ScraperSource,
  opts: RunScrapeOptions = {},
): Promise<ScrapeResult> {
  const pages = opts.pages ?? 1;
  const f = opts.fetchImpl ?? fetch;
  const startedAt = new Date();
  const listings: NormalizedListing[] = [];
  const errors: string[] = [];
  let pagesVisited = 0;

  const robots = await ensureRobots(source.baseUrl, f);
  const delay = robots.crawlDelaySec
    ? Math.max(opts.delayMs ?? 0, robots.crawlDelaySec * 1000)
    : (opts.delayMs ?? 1500);

  const firstPage = Math.max(1, opts.startPage ?? 1);
  const lastRequestedPage = firstPage + pages - 1;
  const streakLimit = Math.max(1, opts.endOfCatalogStreak ?? 3);
  // Consecutive 403/429 from the host before the walk stands down. Deliberately
  // short: a source that has refused three pages in a row is not about to
  // accept the fourth, and continuing is how the August block was earned.
  const BLOCKED_STREAK_LIMIT = 3;
  const outcomes: PageOutcome[] = [];
  let emptyStreak = 0;
  let blockedStreak = 0;
  // The last page we actually got an answer about. On a block the walk rewinds
  // to here, so refused pages are retried next run instead of being skipped:
  // advanceCursor only holds position when the WHOLE run failed, and a run that
  // read 100 pages and was then refused would otherwise leave a hole.
  let lastGoodPage = firstPage - 1;
  let lastPage = firstPage - 1;
  let stoppedReason: ScrapeResult['stoppedReason'] = 'range';

  for (let page = firstPage; page <= lastRequestedPage; page++) {
    const url = source.pageUrl({ page });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      errors.push(`page ${page}: invalid URL produced by source.pageUrl: ${url}`);
      continue;
    }
    const pathWithQuery = parsed.pathname + parsed.search;
    if (!robots.perPath(pathWithQuery)) {
      throw new ScrapeForbiddenError(
        `${source.id} robots.txt disallows ${pathWithQuery} for ${USER_AGENT}`,
      );
    }
    try {
      const res = await f(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      });
      pagesVisited++;
      lastPage = page;
      if (res.status === 404 || res.status === 410) {
        outcomes.push({ page, kind: 'notFound', listings: 0 });
        emptyStreak++;
        lastGoodPage = page;
      } else if (res.status === 403 || res.status === 429) {
        // Being refused is different from a page erroring, and it is the one
        // failure that gets worse the longer we keep going. In August a full
        // catalogue walk paired with detail enrichment on the same host ended
        // with autobazar.sk refusing our egress IP for four days. Now that the
        // walk runs twice as often, it needs its own brake: back off after a
        // short run of refusals rather than working through the whole slice.
        //
        // The cursor is not advanced past a refused page (nothing is parsed),
        // so the walk simply resumes here next run.
        outcomes.push({ page, kind: 'error', listings: 0, message: `HTTP ${res.status}` });
        errors.push(`page ${page}: HTTP ${res.status}`);
        blockedStreak++;
        emptyStreak = 0;
        if (blockedStreak >= BLOCKED_STREAK_LIMIT) {
          stoppedReason = 'blocked';
          lastPage = lastGoodPage;
          break;
        }
      } else if (!res.ok) {
        outcomes.push({ page, kind: 'error', listings: 0, message: `HTTP ${res.status}` });
        errors.push(`page ${page}: HTTP ${res.status}`);
        emptyStreak = 0;
        blockedStreak = 0;
        lastGoodPage = page;
      } else {
        blockedStreak = 0;
        lastGoodPage = page;
        const html = await res.text();
        const pageListings = source.parseListingsPage(html);
        listings.push(...pageListings);
        if (pageListings.length === 0) {
          outcomes.push({ page, kind: 'empty', listings: 0 });
          emptyStreak++;
        } else {
          outcomes.push({ page, kind: 'ok', listings: pageListings.length });
          emptyStreak = 0;
        }
      }
    } catch (e) {
      lastPage = page;
      const message = e instanceof Error ? e.message : 'unknown error';
      outcomes.push({ page, kind: 'error', listings: 0, message });
      errors.push(`page ${page}: ${message}`);
      emptyStreak = 0;
    }

    // Past the declared end of the space, a streak of nothing means the source
    // is exhausted rather than broken. Inside it, an empty page is just a short
    // brand in a ragged sequence and the walk carries on.
    const pastDeclaredEnd = source.maxPage == null || page >= source.maxPage;
    if (emptyStreak >= streakLimit && pastDeclaredEnd) {
      stoppedReason = 'endOfCatalog';
      break;
    }
    if (opts.deadline != null && Date.now() + delay >= opts.deadline) {
      stoppedReason = 'deadline';
      break;
    }
    if (page < lastRequestedPage) await sleep(delay);
  }

  return {
    source: source.id,
    startedAt,
    finishedAt: new Date(),
    listings,
    pagesVisited,
    errors,
    outcomes,
    lastPage,
    stoppedReason,
  };
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Re-export for ergonomic imports from API routes / scripts. */
export { ScrapeForbiddenError, USER_AGENT } from './sources/source-interface';
export type { ScraperSource } from './sources/source-interface';
export type { RunScrapeOptions as ScrapeOptions };
export type { Source };

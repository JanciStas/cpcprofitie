import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRobotsCache, runScrape } from '../scrape';
import type { ScraperSource } from '../sources/source-interface';

// The catalogue walk now runs twice as often, and that is exactly the move that
// took autobazar.sk dark for four days in August. These pin the brake.

const source: ScraperSource = {
  id: 'autobazar.sk',
  baseUrl: 'https://www.autobazar.sk',
  pageUrl: ({ page }) => `https://www.autobazar.sk/osobne-auta/?page=${page}`,
  parseListingsPage: (html) =>
    html.includes('CAR')
      ? [
          {
            source: 'autobazar.sk',
            sourceId: 'x',
            url: 'https://www.autobazar.sk/1/x/',
            makeSlug: null,
            modelSlug: null,
            priceEur: null,
            year: null,
            mileageKm: null,
            fuel: null,
            transmission: null,
            region: null,
            rawTitle: null,
            rawPayload: {},
          },
        ]
      : [],
};

/** Answers each page with the status `statusFor` picks. */
function fetchPages(statusFor: (page: number) => number): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/robots.txt')) return new Response('', { status: 200 });
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    const status = statusFor(page);
    return new Response(status === 200 ? 'CAR' : '', { status });
  }) as unknown as typeof fetch;
}

beforeEach(() => __resetRobotsCache());

describe('the walk stands down when the host refuses it', () => {
  it('stops on a run of 403s instead of working through the slice', async () => {
    const r = await runScrape(source, {
      startPage: 1,
      pages: 50,
      delayMs: 0,
      fetchImpl: fetchPages((p) => (p >= 3 ? 403 : 200)),
    });
    expect(r.stoppedReason).toBe('blocked');
    // Three refusals end it, so it must not have walked anywhere near 50 pages.
    expect(r.outcomes.length).toBeLessThan(10);
  });

  it('treats 429 the same way', async () => {
    const r = await runScrape(source, {
      startPage: 1,
      pages: 50,
      delayMs: 0,
      fetchImpl: fetchPages((p) => (p >= 2 ? 429 : 200)),
    });
    expect(r.stoppedReason).toBe('blocked');
  });

  it('rewinds to the last page it got an answer about', async () => {
    // advanceCursor only holds position when the WHOLE run failed. A run that
    // read pages 1-4 and was then refused would otherwise move the cursor past
    // the refused pages and leave a hole in the catalogue.
    const r = await runScrape(source, {
      startPage: 1,
      pages: 50,
      delayMs: 0,
      fetchImpl: fetchPages((p) => (p >= 5 ? 403 : 200)),
    });
    expect(r.stoppedReason).toBe('blocked');
    expect(r.lastPage).toBe(4);
  });

  it('does not stand down for ordinary server errors', async () => {
    // A 500 is the source having a bad moment, not refusing us. Backing off
    // there would stall the walk on a transient blip.
    const r = await runScrape(source, {
      startPage: 1,
      pages: 6,
      delayMs: 0,
      fetchImpl: fetchPages((p) => (p === 2 ? 500 : 200)),
    });
    expect(r.stoppedReason).not.toBe('blocked');
    expect(r.outcomes.length).toBe(6);
  });

  it('does not stand down on a single isolated refusal', async () => {
    const r = await runScrape(source, {
      startPage: 1,
      pages: 6,
      delayMs: 0,
      fetchImpl: fetchPages((p) => (p === 2 ? 403 : 200)),
    });
    expect(r.stoppedReason).not.toBe('blocked');
    expect(r.outcomes.length).toBe(6);
  });
});

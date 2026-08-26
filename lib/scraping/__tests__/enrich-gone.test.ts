import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_GONE_SHARE,
  MIN_GONE_FOR_GUARD,
  MassGoneError,
  __resetEnrichRobotsCache,
  runEnrichment,
} from '../enrich';
import type { ScraperSource } from '../sources/source-interface';
import type { NormalizedListing } from '../types';

// The gone path had no test at all, which is how 403 stayed in it long enough
// to mark 3 676 bazos listings removed in a single day. Every one of those fed
// the sold detector, and `removed_at` is acted on before anyone reads a chart.

function listing(sourceId: string): NormalizedListing {
  return {
    source: 'bazos.sk',
    sourceId,
    url: `https://www.bazos.sk/inzerat/${sourceId}/`,
    makeSlug: 'skoda',
    modelSlug: 'octavia',
    priceEur: 5000,
    year: 2012,
    mileageKm: 200_000,
    fuel: null,
    transmission: null,
    region: null,
    rawTitle: 'Škoda Octavia',
    rawPayload: {},
  };
}

const source: ScraperSource = {
  id: 'bazos.sk',
  baseUrl: 'https://www.bazos.sk',
  pageUrl: ({ page }) => `https://www.bazos.sk/auto/${page}/`,
  parseListingsPage: () => [],
  detailUrl: (l) => l.url,
  parseDetailPage: (_html, l) => ({
    source: 'bazos.sk',
    sourceId: l.sourceId,
    photos: [],
    description: 'ok',
    vin: null,
    bodyType: null,
    colorExterior: null,
    colorInterior: null,
    powerKw: null,
    engineCcm: null,
    sellerType: null,
    sellerName: null,
    equipment: [],
  }),
};

/** Fetch stub: robots.txt is always empty, listing pages answer with `status`. */
function fetchReturning(statusFor: (sourceId: string) => number): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/robots.txt')) return new Response('', { status: 200 });
    const id = url.match(/inzerat\/(\d+)/)?.[1] ?? '';
    const status = statusFor(id);
    return new Response(status === 200 ? '<html></html>' : '', { status });
  }) as unknown as typeof fetch;
}

beforeEach(() => __resetEnrichRobotsCache());

describe('what counts as gone', () => {
  it('tombstones a 404 and records the reason', async () => {
    const res = await runEnrichment(source, [listing('1')], {
      delayMs: 0,
      fetchImpl: fetchReturning(() => 404),
    });
    expect(res.details).toHaveLength(1);
    expect(res.details[0]!.gone).toBe(true);
    // The reason is in the tombstone because '[GONE]' alone could not be
    // audited after the fact.
    expect(res.details[0]!.description).toBe('[GONE:404]');
  });

  it('tombstones a 410 the same way', async () => {
    const res = await runEnrichment(source, [listing('1')], {
      delayMs: 0,
      fetchImpl: fetchReturning(() => 410),
    });
    expect(res.details[0]!.gone).toBe(true);
    expect(res.details[0]!.description).toBe('[GONE:410]');
  });

  it('does NOT treat 403 as gone', async () => {
    // 403 means the source is blocking us. It says nothing about the car, and
    // reading it as a deletion is how a rate-limit episode becomes a week of
    // fabricated market movement.
    const res = await runEnrichment(source, [listing('1')], {
      delayMs: 0,
      fetchImpl: fetchReturning(() => 403),
    });
    expect(res.details).toHaveLength(0);
    expect(res.errors).toEqual(['1: HTTP 403']);
  });

  it('does not tombstone a 500 either', async () => {
    const res = await runEnrichment(source, [listing('1')], {
      delayMs: 0,
      fetchImpl: fetchReturning(() => 500),
    });
    expect(res.details).toHaveLength(0);
    expect(res.errors).toHaveLength(1);
  });
});

describe('mass-gone guard', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => listing(String(i + 1)));

  it('refuses a batch that is mostly gone', async () => {
    // Listings do not vanish in bulk. A batch like this is our failure, and
    // refusing it is the cheap direction to be wrong in: the rows come back on
    // the next pass, whereas removed_at is irreversible in practice.
    await expect(
      runEnrichment(source, many(100), {
        delayMs: 0,
        limit: 100,
        fetchImpl: fetchReturning((id) => (Number(id) <= 60 ? 404 : 200)),
      }),
    ).rejects.toBeInstanceOf(MassGoneError);
  });

  it('lets an ordinary share of gone pages through', async () => {
    // One in ten is a normal day; the ceiling must not fire on it.
    const res = await runEnrichment(source, many(100), {
      delayMs: 0,
      limit: 100,
      fetchImpl: fetchReturning((id) => (Number(id) <= 10 ? 404 : 200)),
    });
    expect(res.details.filter((d) => d.gone)).toHaveLength(10);
    expect(res.details).toHaveLength(100);
  });

  it('does not fire on a short batch that is entirely gone', async () => {
    // The share alone would read 100% here. A handful of dead listings in a
    // short batch is ordinary; only a large absolute count is evidence that the
    // source, not the market, changed.
    const n = MIN_GONE_FOR_GUARD - 1;
    const res = await runEnrichment(source, many(n), {
      delayMs: 0,
      fetchImpl: fetchReturning(() => 404),
    });
    expect(res.details).toHaveLength(n);
  });

  it('does not fire on a batch with nothing gone', async () => {
    const res = await runEnrichment(source, many(3), {
      delayMs: 0,
      fetchImpl: fetchReturning(() => 200),
    });
    expect(res.details).toHaveLength(3);
  });

  it('keeps the ceiling where the measurement put it', () => {
    // A normal batch reports low single digits gone; the 25 August bazos
    // episode was effectively 100%. Anything above this is disbelieved.
    expect(MAX_GONE_SHARE).toBe(0.2);
  });
});

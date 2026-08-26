// What one HEAD response says about whether a listing is still on sale.
//
// Pulled out of the cron route so it can be tested against the responses the
// real sources actually give, which is how the 308 bug below was found.

export type LivenessVerdict = 'gone' | 'live' | 'blocked' | 'unknown';

/**
 * @param status   HTTP status of a `redirect: 'manual'` HEAD request.
 * @param location The Location header, when there is one.
 * @param sourceId The source's own id for this listing.
 */
export function classifyHeadResponse(
  status: number,
  location: string | null,
  sourceId: string,
): LivenessVerdict {
  // Being refused says nothing about the car. Recording it as a departure is
  // what turned one afternoon of rate limiting into 3 676 listings marked gone.
  if (status === 403 || status === 429) return 'blocked';
  if (status === 404 || status === 410) return 'gone';

  if (status >= 300 && status < 400) {
    // autobazar.eu answers 308 on EVERY detail URL, so a plain
    // `status < 400 means alive` rule could not tell living from dead on 43% of
    // the corpus — it called all of it alive.
    //
    // The target decides, the same test enrich.ts applies: a redirect that
    // keeps the listing's own id is canonicalisation (trailing slash, www) and
    // the advert is still there. One that drops the id has landed on a search
    // page or the home page, which is what a deleted advert does.
    if (!location) return 'unknown';
    return location.includes(sourceId) ? 'live' : 'gone';
  }

  if (status >= 200 && status < 300) return 'live';

  // 5xx and anything else: the source is unwell, which is not news about the car.
  return 'unknown';
}

import { describe, expect, it } from 'vitest';
import { classifyHeadResponse } from '../liveness';

const ID = 'AmTJmdVvP57';

describe('a redirect is not proof of life', () => {
  it('reads a canonicalising redirect as still there', () => {
    // Measured against the real source: autobazar.eu answers 308 on EVERY
    // detail URL, live or not. The rule that shipped first was
    // `status >= 200 && status < 400 means alive`, which called all of
    // autobazar.eu alive -- 43% of the corpus, permanently undecidable.
    expect(classifyHeadResponse(308, `https://www.autobazar.eu/detail/x/${ID}/`, ID)).toBe('live');
    expect(classifyHeadResponse(301, `https://www.autobazar.eu/detail/x/${ID}`, ID)).toBe('live');
  });

  it('reads a redirect that drops the listing id as gone', () => {
    // A deleted advert lands on a search page or the home page. Parsing that
    // would scrape another car's price into this listing, which is why
    // enrich.ts applies the same test.
    expect(classifyHeadResponse(308, 'https://www.autobazar.eu/', ID)).toBe('gone');
    expect(classifyHeadResponse(302, 'https://www.autobazar.eu/osobne-vozidla/', ID)).toBe('gone');
  });

  it('decides nothing when a redirect names no target', () => {
    expect(classifyHeadResponse(308, null, ID)).toBe('unknown');
  });
});

describe('being refused is not evidence about the car', () => {
  it('classifies 403 and 429 as blocked, never as gone', () => {
    // Reading 403 as a deletion is what marked 3 676 bazos listings removed in
    // a single day, every one of them feeding the sold detector.
    expect(classifyHeadResponse(403, null, ID)).toBe('blocked');
    expect(classifyHeadResponse(429, null, ID)).toBe('blocked');
  });

  it('leaves a server error undecided', () => {
    expect(classifyHeadResponse(500, null, ID)).toBe('unknown');
    expect(classifyHeadResponse(503, null, ID)).toBe('unknown');
  });
});

describe('the plain answers', () => {
  it('takes 404 and 410 as gone', () => {
    expect(classifyHeadResponse(404, null, ID)).toBe('gone');
    expect(classifyHeadResponse(410, null, ID)).toBe('gone');
  });

  it('takes 2xx as alive', () => {
    expect(classifyHeadResponse(200, null, ID)).toBe('live');
    expect(classifyHeadResponse(204, null, ID)).toBe('live');
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDetailPage } from '../autobazar-sk-detail';
import type { NormalizedListing } from '../../types';

// Real, trimmed detail page captured from autobazar.sk (scripts/styles removed).
const FIXTURE = readFileSync(
  fileURLToPath(new URL('../__fixtures__/autobazar-sk-detail.html', import.meta.url)),
  'utf8',
);

const LISTING: NormalizedListing = {
  source: 'autobazar.sk',
  sourceId: '28001536',
  url: 'https://www.autobazar.sk/28001536/audi-a3/',
  makeSlug: 'audi',
  modelSlug: 'audi-a3',
  priceEur: null,
  year: null,
  mileageKm: null,
  fuel: null,
  transmission: null,
  region: null,
  rawTitle: null,
  rawPayload: {},
};

describe('VIN', () => {
  // autobazar.sk publishes the VIN plainly, and we recorded it for 0% of 24 528
  // listings. The cause was reading it out of the flattened page text with a
  // case-insensitive /VIN/ that matched an unrelated token earlier in the
  // document -- exec returns the FIRST match, so the real value was never
  // reached. VIN is the strongest identity key we have; it is what finds the
  // 3 294 cars currently listed on more than one portal at once.
  it('reads the VIN out of the parameters block', () => {
    const d = parseDetailPage(FIXTURE, LISTING);
    expect(d.vin).toBe('WAUZZZ8V9EA151208');
  });

  it('is not fooled by a token that merely contains the letters vin', () => {
    // The live page carries a nonce like `VinpswXngc72xXp0tU3` before the real
    // parameters block. Text scanning captured 16 characters of that, failed
    // the 17-character check, and returned null.
    const poisoned = FIXTURE.replace('<body', '<body data-nonce="VinpswXngc72xXp0tU3"');
    const d = parseDetailPage(poisoned, LISTING);
    expect(d.vin).toBe('WAUZZZ8V9EA151208');
  });

  it('returns null rather than a guess when the page has no VIN', () => {
    const stripped = FIXTURE.replace(/WAUZZZ8V9EA151208/g, '');
    expect(parseDetailPage(stripped, LISTING).vin).toBeNull();
  });
});

describe('the other labelled fields', () => {
  // These still read from the flattened page text, which is the same mechanism
  // that silently lost the VIN. They work today; this pins them so that if the
  // page ever grows a decoy the way it did for VIN, a test says so instead of a
  // column quietly going empty.
  it('reads every spec the parameters block carries', () => {
    const d = parseDetailPage(FIXTURE, LISTING);
    expect(d.bodyType).toBe('Hatchback');
    expect(d.powerKw).toBe(110);
    expect(d.engineCcm).toBe(1968);
  });

  it('leaves colour null, because the source does not publish it', () => {
    // Checked against the page: there is no "Farba" anywhere on it, in the
    // parameters block or out of it. Null here is the honest answer, not a
    // parser miss -- worth pinning so nobody "fixes" it into a guess.
    const d = parseDetailPage(FIXTURE, LISTING);
    expect(d.colorExterior).toBeNull();
  });
});

describe('autobazar.sk parseDetailPage', () => {
  it('extracts the sale price into listingOverrides (backfills null-price rows)', () => {
    const d = parseDetailPage(FIXTURE, LISTING);
    expect(d.listingOverrides?.priceEur).toBe(11200);
  });

  it('backfills year/mileage/fuel/transmission from the detail specs', () => {
    const d = parseDetailPage(FIXTURE, LISTING);
    expect(d.listingOverrides?.year).toBe(2014);
    expect(d.listingOverrides?.mileageKm).toBe(192000);
    expect(d.listingOverrides?.fuel).toBe('diesel');
    expect(d.listingOverrides?.transmission).toBe('automatic');
  });

  it('does NOT emit a region override (detail location is unreliable)', () => {
    const d = parseDetailPage(FIXTURE, LISTING);
    expect(d.listingOverrides?.region).toBeUndefined();
  });

  it('emits NO price for a price-on-request page even when body has other € figures', () => {
    // "Cena dohodou" page: empty price box, but a financing widget and a
    // related-listing carousel carry € amounts. A body-first-€ scan would
    // grab the akontácia (2 576 €) — the price element anchor must not.
    const dohodou =
      '<html><body>' +
      '<div class="p-amount"></div>' +
      '<div class="finance">Výška akontácie <span>2 576</span> €</div>' +
      '<div class="similar"><a>Iné Audi</a> 18 900 €</div>' +
      '</body></html>';
    const d = parseDetailPage(dohodou, LISTING);
    expect(d.listingOverrides?.priceEur).toBeUndefined();
  });

  it('rejects an out-of-bounds price in the price element', () => {
    const junk = '<html><body><h2 class="p-amount">1 500 000 €</h2></body></html>';
    const d = parseDetailPage(junk, LISTING);
    expect(d.listingOverrides?.priceEur).toBeUndefined();
  });

  it('captures seller type and photos', () => {
    const d = parseDetailPage(FIXTURE, LISTING);
    expect(d.sellerType).toBe('dealer');
    expect(d.photos.length).toBeGreaterThan(0);
  });
});

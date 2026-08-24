import { describe, expect, it } from 'vitest';
import { parseMakeModel } from '../normalize';
import { REJECTED_MODEL_CANDIDATES, isKnownModel } from '../vehicle-dictionary';

// The dictionary is derived from BRAND_MODEL_BUCKETS, which is a crawl plan:
// roughly the top fifteen models per brand. As a dictionary it left 6 079
// listings with a year, a mileage and a price and no model at all, so they
// could not be compared to anything. EXTRA_MODELS closes that, mined from our
// own corpus and read by hand.
describe('models mined from the corpus', () => {
  it('recognises the names the crawl plan never listed', () => {
    for (const [title, make, model] of [
      ['Audi Q2 1.4 TFSI COD S tronic Basis', 'audi', 'q2'],
      ['BMW i4 eDrive40 Gran Coupé', 'bmw', 'i4'],
      ['Mercedes-Benz GLC 220 4MAT', 'mercedes-benz', 'glc'],
      ['Volkswagen Beetle 2.0 TDI BMT Design DSG', 'volkswagen', 'beetle'],
      ['Toyota Avensis Luna 2.0 D-4D', 'toyota', 'avensis'],
      ['Renault Master 2.3 dCi', 'renault', 'master'],
      ['Peugeot Partner Tepee 1.6 HDi', 'peugeot', 'partner'],
      ['Lexus LBX 1.5 Elegant', 'lexus', 'lbx'],
    ] as const) {
      expect(parseMakeModel(title)).toEqual({ makeSlug: make, modelSlug: model });
    }
  });

  it('folds an alternative spelling onto the entry that already exists', () => {
    // A second spelling stored as a second model splits one cohort in half —
    // the failure this module was written to stop.
    expect(parseMakeModel('Honda CRV 2.2 i-CTDi')).toEqual({
      makeSlug: 'honda',
      modelSlug: 'cr-v',
    });
    expect(parseMakeModel('Mazda CX5 2.2 Skyactiv-D')).toEqual({
      makeSlug: 'mazda',
      modelSlug: 'cx-5',
    });
    expect(parseMakeModel('Mitsubishi L200 2.5 DI-D')).toEqual({
      makeSlug: 'mitsubishi',
      modelSlug: 'l-200',
    });
  });

  it('reads the Czech spelling of a BMW series', () => {
    // "Řada" slugifies to `rada` while the dictionary holds `rad-3`. Fifty-one
    // listings sat unmatched on that one letter.
    expect(parseMakeModel('BMW Řada 3 320d xDrive')).toEqual({
      makeSlug: 'bmw',
      modelSlug: 'rad-3',
    });
    // Only two tokens after the brand are considered, so a three-word model
    // lands on its two-word parent. rad-3 is the right cohort for a 3 Touring
    // anyway; this pins the behaviour rather than pretending it goes deeper.
    expect(parseMakeModel('BMW Rad 3 Touring')).toEqual({
      makeSlug: 'bmw',
      modelSlug: 'rad-3',
    });
  });

  it('reads a Mercedes class written as a bare letter', () => {
    // "Mercedes-Benz C 220" is how sellers write it; the crawl plan only has
    // body-specific variants like c-trieda-sedan. A class with no body stated
    // is still a class.
    expect(parseMakeModel('Mercedes-Benz C 220 d')).toEqual({
      makeSlug: 'mercedes-benz',
      modelSlug: 'c-trieda',
    });
    expect(parseMakeModel('Mercedes-Benz E 350 BlueEFFICIENCY')).toEqual({
      makeSlug: 'mercedes-benz',
      modelSlug: 'e-trieda',
    });
  });
});

describe('candidates measured and rejected', () => {
  // Each of these came out of the same mining pass as the additions above and
  // each looks exactly like a model. Keeping them out is what stops chassis
  // codes, engine variants and bare digits from becoming catalogue entries.
  it('never admits the noise the mining pass turned up', () => {
    for (const pair of REJECTED_MODEL_CANDIDATES) {
      const [brand, model] = pair.split('|') as [string, string];
      expect(isKnownModel(brand, model)).toBe(false);
    }
  });

  it('leaves a listing model-less rather than inventing one', () => {
    // A chassis code is not a model, and a brand with an unrecognised model is
    // a clean unknown — an invented one silently poisons every median.
    expect(parseMakeModel('BMW e46 320d na diely')).toEqual({
      makeSlug: 'bmw',
      modelSlug: null,
    });
  });
});

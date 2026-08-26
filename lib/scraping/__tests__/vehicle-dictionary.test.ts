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
    // A brand with an unrecognised model is a clean unknown — an invented one
    // silently poisons every median.
    expect(parseMakeModel('Subaru Uncharted 2.0')).toEqual({
      makeSlug: 'subaru',
      modelSlug: null,
    });
  });

  it('still reads the series when the ad is selling the car for parts', () => {
    // Used to return null: the chassis code blocked the lookup. Whether the
    // listing is a whole car is is_vehicle's job, not the matcher's — here the
    // model genuinely is a 3 series.
    expect(parseMakeModel('BMW e46 320d na diely')).toEqual({
      makeSlug: 'bmw',
      modelSlug: 'rad-3',
    });
  });
});

describe('brand-scoped shorthands', () => {
  it('reads a BMW series written as a bare number', () => {
    // A bare digit was rejected as a model because it would collide across
    // brands. Scoped to a brand there is nothing to collide with, and 226
    // listings sat on that over-broad reading.
    expect(parseMakeModel('BMW 1 120d xDrive, 4X4, Navi')).toEqual({
      makeSlug: 'bmw',
      modelSlug: 'rad-1',
    });
    expect(parseMakeModel('BMW 3 318 d Automat, Xenóny')).toEqual({
      makeSlug: 'bmw',
      modelSlug: 'rad-3',
    });
  });

  it('still refuses a bare digit that is not brand-scoped', () => {
    // MG 3 is a real model spelled mg3; a loose digit rule would have made
    // every "<brand> 3" into a series.
    expect(parseMakeModel('Fiat 3 nieco')).toEqual({ makeSlug: 'fiat', modelSlug: null });
  });

  it('reads the Czech word order for a Mercedes class', () => {
    expect(parseMakeModel('Mercedes-Benz Třída C 2.2 CDI C 220')).toEqual({
      makeSlug: 'mercedes-benz',
      modelSlug: 'c-trieda',
    });
  });

  it('looks past a body descriptor to find the model', () => {
    // "MINI 3-door Cooper SE" names the body where the model goes.
    expect(parseMakeModel('MINI 3-door Cooper SE 32 kWh')).toEqual({
      makeSlug: 'mini',
      modelSlug: 'cooper',
    });
  });
});

describe('BMW engine designations', () => {
  it('reads the series out of the engine code', () => {
    // BMW names its cars systematically: the first digit of 320i, 530d or 120d
    // is the series. Exact, not a guess. 273 otherwise-complete listings sat on
    // this, rejected in the first pass as "an engine variant, not a model" --
    // right about it not being a model, wrong about it being useless.
    for (const [title, model] of [
      ['BMW 320i xDrive A/T, 135kW (2015)', 'rad-3'],
      ['BMW 530d xDrive 2017 195kW Luxury Line', 'rad-5'],
      ['BMW 120d 130 kW | 2011 | 6-st. manuál', 'rad-1'],
      ['BMW 420d xDrive Gran Coupé', 'rad-4'],
    ] as const) {
      expect(parseMakeModel(title)).toEqual({ makeSlug: 'bmw', modelSlug: model });
    }
  });

  it('steps past a chassis code to reach the engine', () => {
    // "BMW E46 330d" puts the generation where the model goes.
    expect(parseMakeModel('BMW E46 330d 150kW M/6q')).toEqual({
      makeSlug: 'bmw',
      modelSlug: 'rad-3',
    });
    expect(parseMakeModel('BMW F10 530d xDrive M-Packet')).toEqual({
      makeSlug: 'bmw',
      modelSlug: 'rad-5',
    });
  });

  it('lets a real model name win over the derivation', () => {
    // X5 and i4 are models; the derivation is only ever a fallback.
    expect(parseMakeModel('BMW X5 xDrive30d')).toEqual({ makeSlug: 'bmw', modelSlug: 'x5' });
    expect(parseMakeModel('BMW i4 eDrive40')).toEqual({ makeSlug: 'bmw', modelSlug: 'i4' });
  });

  it('does not invent a series where there is none', () => {
    // "5GT" has no three-digit run, "iX M60" does not start with a digit, and
    // a three-digit Fiat is not a BMW.
    expect(parseMakeModel('BMW 5GT 530d xDrive GT')).toEqual({
      makeSlug: 'bmw',
      modelSlug: null,
    });
    expect(parseMakeModel('BMW iX M60')).toEqual({ makeSlug: 'bmw', modelSlug: null });
    expect(parseMakeModel('Fiat 320 nieco')).toEqual({ makeSlug: 'fiat', modelSlug: null });
  });
});

describe('titles that skip the marque', () => {
  it('takes the brand from a model only one brand uses', () => {
    // bazoš sellers routinely leave the marque out. 2 125 cars had a year, a
    // mileage and a price and no model because of it.
    expect(parseMakeModel('Octavia 1.9 TDI 4x4')).toEqual({
      makeSlug: 'skoda',
      modelSlug: 'octavia',
    });
    expect(parseMakeModel('Passat 2.0 TDI DSG')).toEqual({
      makeSlug: 'volkswagen',
      modelSlug: 'passat',
    });
  });

  it('never overrides a brand that is actually in the title', () => {
    // The measured mismatches were all parts ads naming several cars. Every
    // one of them contains a brand, so the fallback must never reach them.
    expect(parseMakeModel('Golf Bmv x1 audi q5 seat leon')).toEqual({
      makeSlug: 'audi',
      modelSlug: 'q5',
    });
  });

  it('refuses a model name two brands share', () => {
    // Ateca is Seat and Cupra; Rexton is SsangYong and KGM. A shared name
    // carries no brand.
    expect(parseMakeModel('Ateca 1.5 TSI')).toEqual({ makeSlug: null, modelSlug: null });
    expect(parseMakeModel('Rexton 2.2')).toEqual({ makeSlug: null, modelSlug: null });
  });

  it('refuses a name too short to mean anything', () => {
    expect(parseMakeModel('320 nieco')).toEqual({ makeSlug: null, modelSlug: null });
  });
});

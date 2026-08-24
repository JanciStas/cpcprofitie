// Canonical vehicle identity: what counts as a brand, and which models belong
// to it.
//
// Why this exists: parseMakeModel used to take the first two words of a title,
// which is fine on a car marketplace and useless on a free classifieds board.
// "Predám Škoda Octavia" produced the make `predam`, and ensureModelId happily
// created a catalog row for it — 1 866 junk makes and 6 777 junk models before
// anyone noticed. Worse, "VW Golf" and "Volkswagen Golf" became two different
// models, splitting a cohort in half and skewing the median every DealScore is
// computed against.
//
// The dictionary is derived from BRAND_MODEL_BUCKETS, which was generated from
// autobazar.eu's own brand/model aggregations (104 brands, 743 pairs) — real
// data, not a hand-written list that would rot.

import { BRAND_MODEL_BUCKETS } from './sources/autobazar-eu';

/** Spellings sellers actually type, mapped to the canonical brand slug. */
const BRAND_ALIASES: Record<string, string> = {
  vw: 'volkswagen',
  mercedes: 'mercedes-benz',
  merc: 'mercedes-benz',
  benz: 'mercedes-benz',
  alfa: 'alfa-romeo',
  land: 'land-rover',
  range: 'land-rover',
  'range-rover': 'land-rover',
  rolls: 'rolls-royce',
  aston: 'aston-martin',
  chevy: 'chevrolet',
  vauxhall: 'opel',
};

/**
 * Models the bucket list does not contain.
 *
 * BRAND_MODEL_BUCKETS is a list of PAGES TO SCRAPE, generated from
 * autobazar.eu's aggregations, which return roughly the top fifteen models per
 * brand. That makes it a fine crawl plan and a poor dictionary: 104 brands but
 * only 743 pairs, so an Audi Q2, a BMW i4, a Mercedes GLC, a VW Beetle or a
 * Toyota Avensis had no model at all. 6 079 listings carried a year, a mileage
 * and a price and still could not be compared to anything, purely because the
 * name was not on that list.
 *
 * Kept separate on purpose: adding them to the bucket list would send the
 * scraper after URLs that may not exist. This is what we RECOGNISE, that is
 * what we FETCH.
 *
 * Every entry was mined from our own corpus — the token after a resolved
 * brand, counted across distinct listings, threshold 8 — and then read by
 * hand. The measurement threw up as much noise as signal; the noise is in
 * REJECTED_CANDIDATES below.
 */
const EXTRA_MODELS: Record<string, readonly string[]> = {
  audi: ['a1', 'a7', 'q2', 'q4', 'tt', 'r8', '80', 's5', 's6', 's7', 's8', 'sq5', 'sq7', 'rs3', 'rs6'],
  bmw: ['i3', 'i4', 'm2', 'm3', 'm4', 'm5', 'z3', 'z4', 'ix1', 'xm', 'rad-2', 'rad-6', 'rad-8'],
  citroen: ['xsara', 'ds3', 'c1'],
  fiat: ['scudo', 'fiorino', '500c', 'stilo', 'fullback'],
  ford: ['fusion', 'ecosport', 'edge', 'ka', 'explorer', 'f-150', 'b-max', 'escort', 'tourneo'],
  hyundai: ['accent', 'getz', 'galloper', 'h1', 'ix55', 'terracan', 'ioniq'],
  iveco: ['eurocargo'],
  kia: ['optima', 'proceed', 'soul', 'carnival', 'stinger'],
  lexus: ['lbx', 'rz'],
  man: ['tgl', 'tgx', 'tga'],
  // Bare class letters are how sellers actually write these ("Mercedes-Benz
  // C 220"), and the bucket list holds only body-specific variants such as
  // c-trieda-sedan. A class with no body stated is still a class.
  'mercedes-benz': [
    'vito', 'sprinter', 'ml', 'cla', 'gl', 'glc', 'citan', 'cls', 'slk', 'cle',
    'gle', 'glk', 'sl', 'viano', 'eqe',
    'c-trieda', 'e-trieda', 's-trieda', 'g-trieda', 'r-trieda', 'x-trieda',
  ],
  multicar: ['m25'],
  opel: ['movano', 'antara', 'adam', 'vectra'],
  peugeot: ['partner', '307', '206', '407', '107', '807'],
  renault: ['master', 'laguna', 'twingo', 'fluence', 'zoe', 'express', 'talisman', 'modus'],
  seat: ['cordoba'],
  skoda: ['citigo', 'felicia'],
  tatra: ['815'],
  toyota: ['avensis', 'verso', 'prius'],
  volkswagen: [
    'transporter', 'amarok', 'crafter', 'caravelle', 't5', 't6', 'tayron',
    'multivan', 'taigo', 'up', 'cc', 'jetta', 'beetle', 'scirocco',
    'california', 'eos', 'fox', 'sportsvan', 'phaeton', 'id3', 'id5',
  ],
  volvo: ['v70', 'xc70', 'c70', 's80'],
};

/**
 * Spellings that mean a model already in the dictionary.
 *
 * Mapped rather than added, because a second spelling stored as a second model
 * splits one cohort in half — the exact failure this module was written to
 * stop ("VW Golf" and "Volkswagen Golf" becoming two models).
 */
const MODEL_ALIASES: Record<string, Record<string, string>> = {
  honda: { crv: 'cr-v' },
  mazda: { cx5: 'cx-5', cx7: 'cx-7', cx3: 'cx-3', cx30: 'cx-30', cx60: 'cx-60', mx5: 'mx-5' },
  mitsubishi: { l200: 'l-200' },
  toyota: { rav: 'rav4' },
  volkswagen: { 'id-3': 'id3', 'id-4': 'id4', 'id-5': 'id5' },
  'mercedes-benz': {
    a: 'a-trieda',
    b: 'b-trieda',
    c: 'c-trieda',
    e: 'e-trieda',
    g: 'g-trieda',
    r: 'r-trieda',
    s: 's-trieda',
    v: 'v-trieda',
    x: 'x-trieda',
  },
};

/**
 * Token rewrites applied before the model lookup.
 *
 * "Řada" is how Czech sellers write BMW's series and it slugifies to `rada`,
 * while the dictionary holds `rad-3`. Fifty-one listings sat unmatched on that
 * one letter.
 */
const TOKEN_ALIASES: Record<string, string> = {
  rada: 'rad',
  serie: 'rad',
};

/**
 * Measured and deliberately NOT added. Each looks like a model and is not:
 *
 *   bmw 1/2/3/5/7      the series number alone; the dictionary holds `rad-3`
 *                      and a bare `3` would collide across brands
 *   bmw e46 f31 e60    chassis codes
 *   bmw 320d 520d      engine variants of a model named elsewhere
 *   mercedes tda tdy   parse noise
 *   mercedes 200 amg   an engine size and a trim
 *   mini 3-door john   a body count and the first word of John Cooper Works
 *   ford grand f       "Grand C-Max" and a truncated F-150
 *   subaru uncharted   a Toyota model, mis-parsed
 *   volvo xc           half of "XC 90"; the number lands in the next token
 *   mg 3               bare digit, and mg3 is already in the dictionary
 */
const REJECTED_CANDIDATES = [
  'bmw|3',
  'bmw|e46',
  'bmw|320d',
  'bmw|styling',
  'mercedes-benz|tda',
  'mercedes-benz|200',
  'mini|3-door',
  'ford|grand',
  'subaru|uncharted',
  'volvo|xc',
] as const;

type Dict = {
  brands: ReadonlySet<string>;
  modelsByBrand: ReadonlyMap<string, ReadonlySet<string>>;
};

let cached: Dict | null = null;

/**
 * Built on first use rather than at module load. normalize.ts imports this
 * module and sources/autobazar-eu.ts imports normalize.ts back, so a top-level
 * build would depend on module initialisation order. By the time anything calls
 * parseMakeModel every module is initialised.
 */
function dict(): Dict {
  if (cached) return cached;
  const brands = new Set<string>();
  const modelsByBrand = new Map<string, Set<string>>();
  for (const { brand, model } of BRAND_MODEL_BUCKETS) {
    brands.add(brand);
    if (!modelsByBrand.has(brand)) modelsByBrand.set(brand, new Set());
    if (model) modelsByBrand.get(brand)!.add(model);
  }
  for (const [brand, models] of Object.entries(EXTRA_MODELS)) {
    brands.add(brand);
    if (!modelsByBrand.has(brand)) modelsByBrand.set(brand, new Set());
    for (const model of models) modelsByBrand.get(brand)!.add(model);
  }
  cached = { brands, modelsByBrand };
  return cached;
}

/** Canonical brand slug for a token, or null when it isn't a brand at all. */
export function resolveBrand(token: string | null | undefined): string | null {
  if (!token) return null;
  const t = token.toLowerCase();
  const aliased = BRAND_ALIASES[t] ?? t;
  return dict().brands.has(aliased) ? aliased : null;
}

/** Known model slugs for a canonical brand. Empty when the brand has none. */
export function modelsFor(brand: string): ReadonlySet<string> {
  return dict().modelsByBrand.get(brand) ?? new Set<string>();
}

/** True when `model` is a known model of `brand`. */
export function isKnownModel(brand: string, model: string): boolean {
  return modelsFor(brand).has(model);
}

/** Rewrite a title token before it is used to look a model up. */
export function canonicalToken(token: string): string {
  return TOKEN_ALIASES[token] ?? token;
}

/**
 * The dictionary's own name for a model slug, or the slug unchanged.
 *
 * Applied before the membership test so a known alternative spelling resolves
 * to the entry that already exists instead of becoming a second model.
 */
export function canonicalModel(brand: string, model: string): string {
  return MODEL_ALIASES[brand]?.[model] ?? model;
}

/** Exported so a test can pin the measured noise out of the dictionary. */
export const REJECTED_MODEL_CANDIDATES: readonly string[] = REJECTED_CANDIDATES;

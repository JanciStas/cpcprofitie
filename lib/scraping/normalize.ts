import type { RawFuel, RawTransmission } from './types';
import {
  bmwSeriesFromEngineCode,
  brandFromUniqueModel,
  canonicalModel,
  canonicalToken,
  isBodyDescriptor,
  isBmwChassisCode,
  modelsFor,
  resolveBrand,
} from './vehicle-dictionary';

const FUEL_MAP: Record<string, RawFuel> = {
  // SK
  benzín: 'gasoline',
  nafta: 'diesel',
  hybrid: 'hybrid',
  'plug-in hybrid': 'phev',
  phev: 'phev',
  elektro: 'electric',
  elektrické: 'electric',
  // CZ
  benzin: 'gasoline',
  diesel: 'diesel',
  elektrický: 'electric',
  hybridní: 'hybrid',
  // Universal
  lpg: 'lpg',
  cng: 'cng',
};

const TRANSMISSION_MAP: Record<string, RawTransmission> = {
  // SK
  manuálna: 'manual',
  manual: 'manual',
  automat: 'automatic',
  automatická: 'automatic',
  // CZ
  manuální: 'manual',
  automatická_cz: 'automatic',
  // Both: 'automatická' covered above
};

export function parseFuel(raw: string | null | undefined): RawFuel | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return FUEL_MAP[key] ?? null;
}

export function parseTransmission(raw: string | null | undefined): RawTransmission | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return TRANSMISSION_MAP[key] ?? null;
}

export function parseEur(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse a Czech-koruna price string ("450 000 Kč") into CZK number. */
export function parseCzk(raw: string | null | undefined): number | null {
  if (!raw) return null;
  if (!/k[čc]|czk/i.test(raw)) {
    // Allow callers to pass pure-digit strings; reject if explicit currency
    // suffix points at something else (e.g. "€").
    if (/€|eur/i.test(raw)) return null;
  }
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Cheap CZK→EUR conversion with a fixed rate. Real rate would come from an
 *  ECB feed; this is fine for "compare order of magnitude" dashboards. */
export const CZK_PER_EUR = 25;

export function czkToEur(czk: number): number {
  return Math.round(czk / CZK_PER_EUR);
}

export function parseKm(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseYear(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /(\d{4})/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1980 && n <= new Date().getFullYear() + 1 ? n : null;
}

export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Heuristic make/model extraction from a free-text title.
//
// This used to take the first two words, which works on a car marketplace
// ("Škoda Octavia 2.0 TDI") and fails on a classifieds board, where titles read
// "Predám Škoda Octavia" or "Ľavé bočné dvere Škoda Fabia". That produced makes
// called `predam` and `rozpredam`, and split VW across `vw` and `volkswagen`.
//
// Now the title is scanned for the first token that is a KNOWN brand, and the
// model is taken from what follows. When no brand is recognised the result is
// null: a listing with no model is a clean unknown, whereas an invented one
// silently poisons the cohort medians that DealScore is built on. That also
// keeps parts listings ("Kolesá", "205/55R16") out of the catalog entirely.
//
// Slugs follow the catalog convention: make `skoda`, model `octavia` — bare,
// not brand-prefixed. The previous `${make}-${model}` form never matched a
// seeded row, so every seeded model sat unused beside an auto-created twin.
export function parseMakeModel(title: string | null | undefined): {
  makeSlug: string | null;
  modelSlug: string | null;
} {
  if (!title) return { makeSlug: null, modelSlug: null };
  const tokens = title
    .trim()
    .split(WHITESPACE_RE)
    .map((t) => canonicalToken(slugify(t)))
    .filter((t) => t.length > 0);

  for (let i = 0; i < tokens.length; i++) {
    // Two-token brands first ("Land Rover", "Alfa Romeo", "Mercedes Benz"),
    // otherwise "land" would resolve and swallow "rover" as the model.
    const paired = i + 1 < tokens.length ? `${tokens[i]}-${tokens[i + 1]}` : null;
    const pairedBrand = paired ? resolveBrand(paired) : null;
    const brand = pairedBrand ?? resolveBrand(tokens[i]);
    if (!brand) continue;

    let after = i + (pairedBrand ? 2 : 1);
    // "MINI 3-door Cooper SE" puts the body where the model goes, and
    // "BMW E46 330d" puts the generation code there. Step past either.
    if (tokens[after] && isBodyDescriptor(tokens[after]!)) after += 1;
    if (tokens[after] && isBmwChassisCode(brand, tokens[after]!)) after += 1;
    const known = modelsFor(brand);
    const one = tokens[after] ?? null;
    const two = one && tokens[after + 1] ? `${one}-${tokens[after + 1]}` : null;

    // Longest match wins: "octavia-combi" before "octavia", "3-series" before "3".
    // canonicalModel folds a known alternative spelling onto the entry that
    // already exists, so "Mazda CX5" does not become a second CX-5 and split
    // the cohort in half.
    const twoCanon = two ? canonicalModel(brand, two) : null;
    const oneCanon = one ? canonicalModel(brand, one) : null;
    if (twoCanon && known.has(twoCanon)) return { makeSlug: brand, modelSlug: twoCanon };
    if (oneCanon && known.has(oneCanon)) return { makeSlug: brand, modelSlug: oneCanon };
    // BMW names its cars after the engine and the first digit is the series,
    // so "320i" and "530d" say rad-3 and rad-5 exactly. Tried last, so a real
    // model name in the dictionary always wins over the derivation.
    const series = one ? bmwSeriesFromEngineCode(brand, one) : null;
    if (series && known.has(series)) return { makeSlug: brand, modelSlug: series };
    // Brand recognised but the model isn't in the dictionary — attach the
    // listing to the brand and leave the model open rather than inventing one.
    return { makeSlug: brand, modelSlug: null };
  }

  // Last resort: no brand anywhere in the title, but the first word is a model
  // name only one brand uses. bazoš sellers routinely skip the marque —
  // "Octavia 1.9 TDI", "Golf", "Passat" — and 2 125 cars with a year, a
  // mileage and a price had no model because of it.
  //
  // Running it only after the whole title failed to yield a brand is what
  // keeps it honest: the mismatches the measurement found were parts ads
  // naming several cars ("Golf Bmv x1 audi q5 seat leon"), and every one of
  // those contains a brand, so this never sees them.
  const first = tokens[0] ?? null;
  const impliedBrand = brandFromUniqueModel(first);
  if (impliedBrand && first) {
    return { makeSlug: impliedBrand, modelSlug: first };
  }

  return { makeSlug: null, modelSlug: null };
}

// ─── Free-text extractors (used by source plugins) ────────────────────────────
// Real listing pages on autobazar.sk / bazos / sauto.cz don't expose price or
// year via dedicated CSS classes — they live in mixed text content next to the
// anchor. These helpers pull the canonical value out of that text.

const WHITESPACE_RE = /\s+/g;

function squeezeDigits(s: string): string {
  return s.replace(WHITESPACE_RE, '');
}

/** Extract EUR price from arbitrary text. */
export function extractEurFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /(\d[\d\s]{1,12})\s*€/.exec(text);
  if (!m) return null;
  const n = Number(squeezeDigits(m[1]!));
  return Number.isFinite(n) && n >= 100 && n < 10_000_000 ? n : null;
}

/** Extract CZK price (sauto.cz format like "385 000 Kč"). */
export function extractCzkFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /(\d[\d\s]{1,12})\s*k[čc]/i.exec(text);
  if (!m) return null;
  const n = Number(squeezeDigits(m[1]!));
  return Number.isFinite(n) && n >= 1000 && n < 100_000_000 ? n : null;
}

/** Extract a plausible vehicle year (1980–nextYear). */
export function extractYearFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  const re = /\b(19|20)\d{2}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[0]);
    if (n >= 1980 && n <= new Date().getFullYear() + 1) return n;
  }
  return null;
}

/** Extract mileage in km from text like "120 000 km". */
export function extractKmFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /(\d[\d\s]{1,8})\s*km\b/i.exec(text);
  if (!m) return null;
  const n = Number(squeezeDigits(m[1]!));
  return Number.isFinite(n) && n >= 0 && n < 2_000_000 ? n : null;
}

const FUEL_HINTS = [
  'benzín',
  'benzin',
  'nafta',
  'diesel',
  'hybridní',
  'hybrid',
  'plug-in',
  'phev',
  'elektrické',
  'elektrický',
  'elektro',
  'lpg',
  'cng',
];

const TRANSMISSION_HINTS = ['manuálna', 'manuální', 'manual', 'automatická', 'automat'];

export function extractFuelHintFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const hint of FUEL_HINTS) {
    if (lower.includes(hint)) return hint;
  }
  return null;
}

export function extractTransmissionHintFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const hint of TRANSMISSION_HINTS) {
    if (lower.includes(hint)) return hint;
  }
  return null;
}

/** Apply the SK-/CZ- prefix to a free-text region. No-op when already prefixed. */
export function prefixRegion(region: string | null, country: string): string | null {
  if (!region) return null;
  const trimmed = region.trim();
  if (!trimmed) return null;
  if (/^[A-Z]{2}-/.test(trimmed)) return trimmed;
  return `${country}-${trimmed}`;
}

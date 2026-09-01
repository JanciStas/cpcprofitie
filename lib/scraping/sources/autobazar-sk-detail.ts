// Detail-page parser for autobazar.sk. Listings detail URLs are
// `/{numericId}/{slug}/` — same as the listing-page anchor, so we re-use the
// listing URL directly.

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { PRICE_MAX, PRICE_MIN } from '@/lib/analytics/quality';
import {
  extractEurFromText,
  extractFuelHintFromText,
  extractKmFromText,
  extractTransmissionHintFromText,
  extractYearFromText,
  parseFuel,
  parseTransmission,
} from '../normalize';
import type { NormalizedDetail, NormalizedListing, SellerType } from '../types';

const NUM_RE = /(\d[\d\s]*)/;

export function detailUrl(listing: NormalizedListing): string {
  return listing.url;
}

export function parseDetailPage(html: string, listing: NormalizedListing): NormalizedDetail {
  const $ = cheerio.load(html);

  // Photos: <a href="...img.autobazar.sk/foto/..."> wrap thumbnail anchors.
  // We dedupe by URL and keep insertion order.
  const photos: string[] = [];
  const seen = new Set<string>();
  $('a[href*="img.autobazar.sk"], img[src*="img.autobazar.sk"]').each((_, el) => {
    const $el = $(el);
    const url = ($el.attr('href') ?? $el.attr('src') ?? '').trim();
    if (!url) return;
    // Skip thumbnail-only variants when a higher-res sibling exists. Bigger
    // file paths usually carry `/foto/` segment; thumbnails carry `/thumb/`.
    if (url.includes('/thumb/')) return;
    if (seen.has(url)) return;
    seen.add(url);
    photos.push(url);
  });

  const fullText = $('body').text();

  // Specs are laid out as "Label: value" pairs in <strong>/<dt>/<td> elements.
  // Use a robust label→value extractor.
  const bodyType = extractAfterLabel(fullText, 'Karoséria');
  const colorExterior = extractAfterLabel(fullText, 'Farba');
  const colorInterior = extractAfterLabel(fullText, 'Interiér');
  const powerKw = parseIntFromText(extractAfterLabel(fullText, 'Výkon'));
  const engineCcm = parseIntFromText(extractAfterLabel(fullText, 'Objem'));
  // Read from the DOM, not from the flattened text like the fields above.
  //
  // extractAfterLabel builds a case-insensitive /VIN\s*:?\s*(...)/ and runs it
  // over the whole page, and exec returns the FIRST match. Anything earlier
  // that merely contains the letters "vin" wins, the capture fails the
  // 17-character check, and the function returns null -- which it did for all
  // 24 528 autobazar.sk listings, while the page carried the VIN in plain sight.
  //
  // The label/value markup is stable and unambiguous, so match on it directly.
  // Every candidate is checked, not just the first, so a stray label elsewhere
  // costs nothing.
  const vin = extractLabelledValue($, 'VIN', isPlausibleVin);

  // Seller block: dealer pages link to `<slug>.autobazar.sk`. Private sellers
  // show "Súkromný predajca" or similar text.
  const $dealerLink = $('a[href*=".autobazar.sk"]').filter((_, a) => {
    const href = $(a).attr('href') ?? '';
    return /\/\/[\w-]+\.autobazar\.sk/.test(href);
  });
  const sellerName = $dealerLink.first().text().trim() || null;
  const sellerType: SellerType | null = $dealerLink.length > 0
    ? 'dealer'
    : /S[uú]kromn[yý]/i.test(fullText)
      ? 'private'
      : null;

  // Equipment: gather <ul><li> items inside sections labeled Bezpečnosť /
  // Komfort / Ďalšia výbava. To keep the parser robust we just collect all
  // <li> entries whose text matches the typical "Klimatizácia" / "Airbag"
  // shape (3-50 chars, no digits at start).
  const equipment: string[] = [];
  $('li').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length < 3 || text.length > 80) return;
    if (/^\d/.test(text)) return;
    if (equipment.includes(text)) return;
    equipment.push(text);
  });

  // Description: the "Poznámka" or seller-notes block. Heuristic: first
  // long paragraph (>200 chars) on the page that isn't a list item.
  let description: string | null = null;
  $('p').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length >= 200 && description === null) {
      description = text.slice(0, 4000);
    }
  });

  // Backfill year/km/fuel/region into listings when detail page has them
  // and the list-page extraction missed (or is null).
  const yearRaw = extractAfterLabel(fullText, 'Rok výroby') ?? extractAfterLabel(fullText, 'Rok');
  const year = parseIntFromText(yearRaw) ?? extractYearFromText(yearRaw);
  const kmRaw =
    extractAfterLabel(fullText, 'Najazdené') ?? extractAfterLabel(fullText, 'Stav km');
  const mileageKm = extractKmFromText(kmRaw ?? '') ?? parseIntFromText(kmRaw);
  const fuelHint = extractAfterLabel(fullText, 'Palivo');
  const fuel = parseFuel(extractFuelHintFromText(fuelHint ?? ''));
  const transHint = extractAfterLabel(fullText, 'Prevodovka');
  const transmission = parseTransmission(extractTransmissionHintFromText(transHint ?? ''));
  // Region is deliberately NOT taken from the detail page: the "Mesto"/
  // "Lokalita" label extraction is unreliable here (it produced junk like
  // "SK-4 l"), and the fixed listing-page parser already yields a clean
  // kraj. Backfilling a junk region into null-region rows would be worse
  // than leaving them null for the next listing-page rescrape.

  // Price: anchor to the actual price element (`.p-amount` / `.n-action_price`)
  // — NEVER the first € in body text. The null-price backlog is dominated by
  // "Cena dohodou" (price-on-request) listings whose price box is empty; on
  // those, a body-text scan would grab the financing widget's akontácia
  // ("2 576 €") or a related-car price and write it as the sale price. No
  // price element → leave null (the row is genuinely price-on-request). Bound
  // to the plausibility range so a mis-parse can't write junk.
  const priceRaw = extractEurFromText($('.p-amount, .n-action_price').first().text());
  const priceEur =
    priceRaw != null && priceRaw >= PRICE_MIN && priceRaw <= PRICE_MAX ? priceRaw : null;

  const listingOverrides: NormalizedDetail['listingOverrides'] = {};
  if (priceEur != null) listingOverrides.priceEur = priceEur;
  if (year != null && year >= 1980 && year <= new Date().getFullYear() + 1)
    listingOverrides.year = year;
  if (mileageKm != null && mileageKm > 0) listingOverrides.mileageKm = mileageKm;
  if (fuel != null) listingOverrides.fuel = fuel;
  if (transmission != null) listingOverrides.transmission = transmission;

  return {
    source: listing.source,
    sourceId: listing.sourceId,
    photos,
    description,
    vin,
    bodyType,
    colorExterior,
    colorInterior,
    powerKw,
    engineCcm,
    sellerType,
    sellerName,
    equipment: equipment.slice(0, 200),
    listingOverrides: Object.keys(listingOverrides).length > 0 ? listingOverrides : undefined,
  };
}

/**
 * Value of a `parameters__label` / `parameters__value` pair, validated.
 *
 * Returns the first candidate that satisfies `accept`, so a page carrying the
 * label more than once (or carrying a decoy) still yields the real value.
 */
function extractLabelledValue(
  $: CheerioAPI,
  label: string,
  accept: (v: string | null) => boolean,
): string | null {
  let found: string | null = null;
  $('.parameters__label').each((_, el) => {
    if (found) return;
    const text = $(el).text().trim().replace(/:$/, '');
    if (text.toUpperCase() !== label.toUpperCase()) return;
    // The value sits in the neighbouring column, not inside the label element.
    const value =
      $(el).closest('div').next().find('.parameters__value').first().text().trim() ||
      $(el).parent().parent().find('.parameters__value').first().text().trim();
    const normalised = value.toUpperCase();
    if (accept(normalised)) found = normalised;
  });
  return found;
}

function extractAfterLabel(text: string, label: string): string | null {
  const re = new RegExp(`${label}\\s*[:\\-]?\\s*([^\\n,;]+?)(?:\\s{2,}|\\n|,|;|$)`, 'i');
  const m = re.exec(text);
  return m?.[1]?.trim() ?? null;
}

function parseIntFromText(text: string | null): number | null {
  if (!text) return null;
  const m = NUM_RE.exec(text);
  if (!m) return null;
  const n = Number(m[1]!.replace(/\s/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isPlausibleVin(s: string | null): boolean {
  if (!s) return false;
  // Modern VIN: 17 chars, A-Z + 0-9 minus I/O/Q.
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(s.trim().toUpperCase());
}

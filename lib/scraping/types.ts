// Shared types for the scraping pipeline. The pipeline emits NormalizedListing
// rows that downstream upsert + aggregation steps consume regardless of source.

export type Source = 'autobazar.sk' | 'autobazar.eu' | 'bazos.sk';

// sauto.cz was deliberately dropped: its robots.txt has
// `User-agent: *  Disallow: /` and only whitelists Googlebot/SeznamBot/etc.
export const ALL_SOURCES: readonly Source[] = [
  'autobazar.sk',
  'autobazar.eu',
  'bazos.sk',
] as const;

export type RawFuel =
  | 'gasoline'
  | 'diesel'
  | 'hybrid'
  | 'phev'
  | 'electric'
  | 'lpg'
  | 'cng'
  | 'other';

export type RawTransmission = 'manual' | 'automatic' | 'other';

export type NormalizedListing = {
  source: Source;
  sourceId: string;
  url: string;
  makeSlug: string | null;
  modelSlug: string | null;
  priceEur: number | null;
  /** Original price in source currency if non-EUR (CZK). Stored for audit. */
  priceCzk?: number | null;
  year: number | null;
  mileageKm: number | null;
  fuel: RawFuel | null;
  transmission: RawTransmission | null;
  region: string | null;
  /**
   * ISO-3166 alpha-2 of the market the advert sits in, or null when the source
   * gives no structural evidence. Null means "unknown", never "assume Slovak" —
   * autobazar.eu is a Czech-Slovak portal and assuming was how ~10 000 Czech
   * cars ended up priced into the Slovak reference.
   */
  country?: string | null;
  /** The town/district as the source names it, before any region derivation. */
  locality?: string | null;
  rawTitle: string | null;
  rawPayload: Record<string, unknown>;
  viewCount?: number | null;
  isFeatured?: boolean;
  sellerPhone?: string | null;
};

/**
 * What one page fetch produced.
 *
 * `notFound` is separate from `error` on purpose. Once the scraper rotates
 * through a source's whole depth, running off the end is the normal outcome of
 * a healthy run — folding it into errors marked those runs failed, and a status
 * that goes red during correct operation stops meaning anything within a week.
 */
export type PageOutcomeKind = 'ok' | 'empty' | 'notFound' | 'error';

export type PageOutcome = {
  page: number;
  kind: PageOutcomeKind;
  listings: number;
  message?: string;
};

export type ScrapeResult = {
  source: Source;
  startedAt: Date;
  finishedAt: Date;
  listings: NormalizedListing[];
  pagesVisited: number;
  /** Only genuine failures — never a 404 at the end of the catalogue. */
  errors: string[];
  outcomes: PageOutcome[];
  /** Highest page reached, so the caller can advance a cursor by what was
   *  actually covered rather than by what was requested. */
  lastPage: number;
  /** Why the walk ended: 'range' (did what was asked), 'deadline' (ran out of
   *  time), or 'endOfCatalog' (source has no more pages). */
  /** 'blocked' = the host refused us repeatedly and the walk stood down. */
  stoppedReason: 'range' | 'deadline' | 'endOfCatalog' | 'blocked';
};

export type SellerType = 'private' | 'dealer';

/** Output of a per-listing detail-page enrichment fetch. Most fields are
 *  optional because not every source publishes them and old listings get
 *  truncated. */
export type NormalizedDetail = {
  source: Source;
  sourceId: string;
  /** The detail fetch resolved to a "gone" state (404/410/403 or a redirect
   *  that dropped the listing id). persistDetails marks the listing removed
   *  and must NOT overwrite an existing enriched detail row with the empty
   *  tombstone fields. */
  gone?: boolean;
  /** Make/model/title recovered from the detail page. Used to backfill
   *  listings that were inserted as title-less/model-less stubs (autobazar.eu
   *  sitemap sweep). persistDetails resolves model_id via ensureModelId and
   *  fills listings.model_id / raw_title only when currently NULL. */
  identity?: {
    makeSlug: string | null;
    modelSlug: string | null;
    rawTitle: string | null;
  };
  /** Full-resolution photo URLs in display order. May be empty. */
  photos: string[];
  description: string | null;
  vin: string | null;
  bodyType: string | null;
  colorExterior: string | null;
  colorInterior: string | null;
  powerKw: number | null;
  engineCcm: number | null;
  sellerType: SellerType | null;
  sellerName: string | null;
  /** Flat list of equipment labels (klimatizácia, ABS, ESP, ...). */
  equipment: string[];
  /** Optional write-back to the listings row. The detail page is usually
   *  more accurate than list cards (full year/km/region/fuel labels),
   *  so we fill these from detail when present and let persistDetails
   *  patch any NULL columns on listings. Never overwrites non-null values. */
  listingOverrides?: Partial<{
    year: number;
    mileageKm: number;
    fuel: RawFuel;
    transmission: RawTransmission;
    region: string;
    locality: string;
    /** ISO country established from the detail page's location tree. */
    country: string;
    /**
     * The detail page says the car is abroad, contradicting the source-level
     * assumption that every row on a national site is domestic. Clears
     * `country` rather than filling it: we learn the row is NOT Slovak, not
     * which country it is in.
     */
    foreignLocality: boolean;
    priceEur: number;
  }>;
};

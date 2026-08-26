import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const planEnum = pgEnum('plan', ['free', 'plus', 'premium']);
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
  'paused',
]);
export const userRoleEnum = pgEnum('user_role', ['user', 'admin']);
export const fuelEnum = pgEnum('fuel', [
  'gasoline',
  'diesel',
  'hybrid',
  'phev',
  'electric',
  'lpg',
  'cng',
  'other',
]);
export const transmissionEnum = pgEnum('transmission', ['manual', 'automatic', 'other']);
export const scrapeStatusEnum = pgEnum('scrape_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  fullName: text('full_name'),
  avatarUrl: text('avatar_url'),
  locale: varchar('locale', { length: 5 }).notNull().default('sk'),
  role: userRoleEnum('role').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    plan: planEnum('plan').notNull().default('free'),
    status: subscriptionStatusEnum('status').notNull().default('trialing'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id').unique(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('subscriptions_user_id_idx').on(t.userId)],
);

export const vehicleMakes = pgTable('vehicle_makes', {
  id: integer('id').primaryKey(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 96 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const vehicleModels = pgTable(
  'vehicle_models',
  {
    id: integer('id').primaryKey(),
    makeId: integer('make_id')
      .notNull()
      .references(() => vehicleMakes.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 96 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    bodyType: varchar('body_type', { length: 32 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('vehicle_models_make_slug_idx').on(t.makeId, t.slug),
    index('vehicle_models_name_idx').on(t.name),
  ],
);

export const sellerTypeEnum = pgEnum('seller_type', ['private', 'dealer']);
export const confidenceEnum = pgEnum('confidence', ['low', 'medium', 'high']);

export const listings = pgTable(
  'listings',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    source: varchar('source', { length: 32 }).notNull(),
    sourceId: varchar('source_id', { length: 128 }).notNull(),
    modelId: integer('model_id').references(() => vehicleModels.id, { onDelete: 'set null' }),
    priceEur: numeric('price_eur', { precision: 10, scale: 2 }),
    year: integer('year'),
    mileageKm: integer('mileage_km'),
    fuel: fuelEnum('fuel'),
    transmission: transmissionEnum('transmission'),
    region: varchar('region', { length: 64 }),
    // ISO-3166 alpha-2 of the market the advert sits in. NULL means unknown,
    // never "assume Slovak" — autobazar.eu is a Czech-Slovak portal and the
    // parser used to hardcode 'SK', which priced ~10 000 Czech cars into the
    // Slovak reference. See 0014_listing_country.sql.
    country: char('country', { length: 2 }),
    // The town/district as the source names it, kept separate from `region` so
    // the region can later be coarsened to a kraj without changing the
    // fingerprint input. See 0014_listing_country.sql.
    locality: varchar('locality', { length: 64 }),
    rawTitle: text('raw_title'),
    url: text('url').notNull(),
    rawJson: jsonb('raw_json'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    soldAt: timestamp('sold_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    fingerprint: varchar('fingerprint', { length: 64 }),
    canonicalListingId: bigint('canonical_listing_id', { mode: 'bigint' }).references(
      (): AnyPgColumn => listings.id,
      { onDelete: 'set null' },
    ),
    viewCount: integer('view_count'),
    isFeatured: boolean('is_featured').notNull().default(false),
    sellerPhone: varchar('seller_phone', { length: 32 }),
    // False for a part sold under a car's brand and model — see 0011_is_vehicle.sql.
    // Defaults true: unclassified means car, because dropping a real car from the
    // market costs far more than leaving one bumper in a cohort.
    isVehicle: boolean('is_vehicle').notNull().default(true),
    // When a price was last actually read from the source. NOT last_seen_at:
    // check-removed stamps that after a HEAD request, which reads no price, so
    // it reports freshness a stale price does not have. See 0012.
    priceCheckedAt: timestamp('price_checked_at', { withTimezone: true }),
    // When we last had evidence the listing really existed — a detail page that
    // parsed, or seeing it again on a list page. NOT first_seen_at, which is
    // only when we imported the URL: 4 205 "sales" were listings already dead
    // the first time we looked. See 0013_observed_alive.sql.
    firstSeenAliveAt: timestamp('first_seen_alive_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('listings_source_source_id_idx').on(t.source, t.sourceId),
    index('listings_model_id_first_seen_idx').on(t.modelId, t.firstSeenAt),
    index('listings_region_idx').on(t.region),
    index('listings_country_model_idx').on(t.country, t.modelId),
    index('listings_fingerprint_idx').on(t.fingerprint),
    index('listings_canonical_idx').on(t.canonicalListingId),
    index('listings_view_count_idx').on(t.viewCount),
  ],
);

// Per-listing detail row populated by a second-pass enrichment scrape of the
// listing's detail URL. 1:1 with `listings.id` — separate table so the cheap
// listing-page snapshot can land first without blocking on detail fetches.
export const listingDetails = pgTable(
  'listing_details',
  {
    listingId: bigserial('listing_id', { mode: 'bigint' })
      .primaryKey()
      .references(() => listings.id, { onDelete: 'cascade' }),
    bodyType: varchar('body_type', { length: 32 }),
    colorExterior: varchar('color_exterior', { length: 64 }),
    colorInterior: varchar('color_interior', { length: 64 }),
    powerKw: integer('power_kw'),
    engineCcm: integer('engine_ccm'),
    vin: varchar('vin', { length: 17 }),
    sellerType: sellerTypeEnum('seller_type'),
    sellerName: text('seller_name'),
    description: text('description'),
    equipment: jsonb('equipment').notNull().default(sql`'[]'::jsonb`),
    detailedAt: timestamp('detailed_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// Photos for a listing. 1:N with `listings.id`. Position is 1-based; the
// hero image is `position = 1`. URLs point at the source CDN; we don't
// rehost.
export const listingPhotos = pgTable(
  'listing_photos',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    listingId: bigserial('listing_id', { mode: 'bigint' })
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    url: text('url').notNull(),
    width: integer('width'),
    height: integer('height'),
  },
  (t) => [
    uniqueIndex('listing_photos_listing_position_idx').on(t.listingId, t.position),
    index('listing_photos_listing_idx').on(t.listingId),
  ],
);

// Year bucket: '2020+', '2015-19', '2010-14', '<2010', 'unknown'
// Mileage bucket: '0-50k', '50-100k', '100-150k', '150k+', 'unknown'
export const marketSnapshots = pgTable(
  'market_snapshots',
  {
    modelId: integer('model_id')
      .notNull()
      .references(() => vehicleModels.id, { onDelete: 'cascade' }),
    region: varchar('region', { length: 64 }).notNull(),
    yearBucket: varchar('year_bucket', { length: 8 }).notNull(),
    mileageBucket: varchar('mileage_bucket', { length: 16 }).notNull(),
    period: varchar('period', { length: 8 }).notNull(),
    capturedOn: timestamp('captured_on', { withTimezone: true }).notNull(),
    avgPriceEur: numeric('avg_price_eur', { precision: 10, scale: 2 }),
    medianPriceEur: numeric('median_price_eur', { precision: 10, scale: 2 }),
    p25PriceEur: numeric('p25_price_eur', { precision: 10, scale: 2 }),
    p75PriceEur: numeric('p75_price_eur', { precision: 10, scale: 2 }),
    countActive: integer('count_active').notNull().default(0),
    // DEAD, kept only so the history is not thrown away. countSold is a
    // numerator with no denominator: it counts departures without recording how
    // many listings were being watched or for how long, so it cannot be
    // compared between models or between weeks. 93% of the sales it was built
    // on were fabricated, and the columns it fed were removed from the UI on
    // 2026-08-20. Nothing writes these any more -- flow lives in
    // model_flow_weekly, with exposure beside every count.
    countSold: integer('count_sold').notNull().default(0),
    daysToSellAvg: numeric('days_to_sell_avg', { precision: 6, scale: 2 }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.modelId, t.region, t.yearBucket, t.mileageBucket, t.period, t.capturedOn],
    }),
    index('market_snapshots_model_period_idx').on(t.modelId, t.period, t.capturedOn),
  ],
);

// Weekly flow per model: observed listing-time and how much of it ended with
// the listing leaving the market. See 0016_model_flow_weekly.sql for why this
// is a separate table rather than columns on market_snapshots -- in short, that
// one measures a stock at an instant and this measures a flow over an interval,
// and its population (price AND year AND mileage) is not this one's.
//
// Counts and exposure are stored; the RATE is never stored. The global rate and
// the shrinkage constant both move as data accumulates, so a stored rate would
// freeze a week-one prior for ever, and weeks could not be pooled by addition.
export const modelFlowWeekly = pgTable(
  'model_flow_weekly',
  {
    modelId: integer('model_id')
      .notNull()
      .references(() => vehicleModels.id, { onDelete: 'cascade' }),
    /** A stratum, never 'all' — private ads turn over on a different clock. */
    source: varchar('source', { length: 32 }).notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    /** Listing-days at risk, closing at last confirmed contact. */
    exposureListingDays: numeric('exposure_listing_days', { precision: 12, scale: 2 }).notNull(),
    listingsObserved: integer('listings_observed').notNull(),
    disappeared: integer('disappeared').notNull(),
    /** The subset we actually saw 404 — measures how right the absence signal is. */
    disappearedConfirmed404: integer('disappeared_confirmed_404').notNull(),
    /** Settled by the 2026-08-26 re-verification: real, but the WEEK may be
     *  wrong. Fine for an overall rate, not for week-over-week movement. */
    disappearedBackfilled: integer('disappeared_backfilled').notNull().default(0),
    reappearedWithin30d: integer('reappeared_within_30d').notNull().default(0),
    priceObsExposureListingDays: numeric('price_obs_exposure_listing_days', {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default('0'),
    priceCuts: integer('price_cuts').notNull().default(0),
    priceRaises: integer('price_raises').notNull().default(0),
    cutDepthPctMedian: numeric('cut_depth_pct_median', { precision: 5, scale: 2 }),
    /** False when the catalogue sweep for this window did not come round clean. */
    sweepComplete: boolean('sweep_complete').notNull().default(false),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.modelId, t.source, t.windowStart] }),
    index('model_flow_weekly_window_idx').on(t.windowStart, t.modelId),
  ],
);

// One row per active canonical listing where price is below market median.
// Recomputed weekly by the maintenance cron; older rows are deleted on each run.
export const flipOpportunities = pgTable(
  'flip_opportunities',
  {
    listingId: bigint('listing_id', { mode: 'bigint' })
      .primaryKey()
      .references(() => listings.id, { onDelete: 'cascade' }),
    marketMedianEur: numeric('market_median_eur', { precision: 10, scale: 2 }).notNull(),
    marketP25Eur: numeric('market_p25_eur', { precision: 10, scale: 2 }).notNull(),
    discountPct: numeric('discount_pct', { precision: 5, scale: 2 }).notNull(),
    potentialGainEur: numeric('potential_gain_eur', { precision: 10, scale: 2 }).notNull(),
    cohortSize: integer('cohort_size').notNull(),
    confidence: confidenceEnum('confidence').notNull(),
    dealScore: integer('deal_score'),
    scoreBreakdown: jsonb('score_breakdown'),
    explainer: text('explainer'),
    estRecondEur: integer('est_recond_eur').default(800),
    estProfitEur: integer('est_profit_eur'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('flip_opportunities_discount_idx').on(t.discountPct),
    index('flip_opportunities_gain_idx').on(t.potentialGainEur),
    index('flip_opportunities_confidence_idx').on(t.confidence),
    index('flip_opportunities_deal_score_idx').on(t.dealScore.desc()),
  ],
);

export const garage = pgTable(
  'garage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    modelId: integer('model_id').references(() => vehicleModels.id, { onDelete: 'set null' }),
    label: text('label'),
    vin: varchar('vin', { length: 17 }),
    year: integer('year'),
    mileageKm: integer('mileage_km'),
    purchasePriceEur: numeric('purchase_price_eur', { precision: 10, scale: 2 }),
    purchaseDate: timestamp('purchase_date', { withTimezone: true }),
    targetMarginEur: numeric('target_margin_eur', { precision: 10, scale: 2 }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('garage_user_id_idx').on(t.userId)],
);

export const watchlist = pgTable(
  'watchlist',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    modelId: integer('model_id').references(() => vehicleModels.id, { onDelete: 'set null' }),
    region: varchar('region', { length: 64 }),
    minPriceEur: numeric('min_price_eur', { precision: 10, scale: 2 }),
    maxPriceEur: numeric('max_price_eur', { precision: 10, scale: 2 }),
    minYear: integer('min_year'),
    maxMileageKm: integer('max_mileage_km'),
    fuel: fuelEnum('fuel'),
    notifyByEmail: boolean('notify_by_email').notNull().default(true),
    lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('watchlist_user_id_idx').on(t.userId)],
);

export const aiListings = pgTable(
  'ai_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    inputJson: jsonb('input_json').notNull(),
    generatedTitle: text('generated_title'),
    generatedBody: text('generated_body'),
    modelUsed: varchar('model_used', { length: 64 }),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_listings_user_created_idx').on(t.userId, t.createdAt)],
);

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    type: varchar('type', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('events_user_created_idx').on(t.userId, t.createdAt),
    // Notification backstop queries filter by (type, created_at) — without
    // this the daily crons seq-scan the whole ever-growing events table.
    index('events_type_created_idx').on(t.type, t.createdAt),
  ],
);

export const scrapeRuns = pgTable(
  'scrape_runs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    source: varchar('source', { length: 32 }).notNull(),
    status: scrapeStatusEnum('status').notNull().default('queued'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    listingsAdded: integer('listings_added').notNull().default(0),
    listingsUpdated: integer('listings_updated').notNull().default(0),
    errorMessage: text('error_message'),
    // What the run covered. A bare 'succeeded' says nothing when a run can
    // touch 1% of the corpus; these are what make the status readable.
    startPage: integer('start_page'),
    endPage: integer('end_page'),
    pagesOk: integer('pages_ok').notNull().default(0),
    pagesEmpty: integer('pages_empty').notNull().default(0),
    pagesNotFound: integer('pages_not_found').notNull().default(0),
    pagesError: integer('pages_error').notNull().default(0),
    cycleNo: integer('cycle_no'),
    stoppedReason: text('stopped_reason'),
  },
  (t) => [index('scrape_runs_source_started_idx').on(t.source, t.startedAt)],
);

// Where the page rotation has got to, per source. See 0012_freshness_rotation.sql
// for why this is a stored cursor rather than a function of the clock.
export const scrapeCursors = pgTable('scrape_cursors', {
  source: varchar('source', { length: 32 }).primaryKey(),
  /** Next page to fetch. Advanced only after the pages are persisted. */
  nextPage: integer('next_page').notNull().default(1),
  /** Declared size of the page space; a change resets the cursor. */
  pageSpace: integer('page_space'),
  /** Highest page observed to return listings — learned, not hardcoded. */
  maxKnownPage: integer('max_known_page'),
  cycleNo: integer('cycle_no').notNull().default(1),
  cycleStartedAt: timestamp('cycle_started_at', { withTimezone: true }).notNull().defaultNow(),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Where a cron-driven backfill got to.
 *
 * The backfills walk by id and hand `nextCursor` back to their caller, which
 * works for a script in a loop and not at all for a cron: a cron fires the same
 * URL every time, so without somewhere to put the cursor every run repeats the
 * first batch for ever. That is why none of the seven tools under
 * app/api/admin was ever scheduled.
 *
 * Rows whose field stays NULL after a successful pass (a title that resolves to
 * no model, an advert with no year printed anywhere) sit at the head of the set
 * permanently, so a cursor is the only thing that lets the walk finish.
 */
export const jobCursors = pgTable('job_cursors', {
  jobKey: varchar('job_key', { length: 64 }).primaryKey(),
  /** Highest id processed. NULL means "start from the beginning". */
  afterId: bigint('after_id', { mode: 'bigint' }),
  /** Bumped every time the set is exhausted and the cursor resets to the top. */
  passNo: integer('pass_no').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const listingPriceHistory = pgTable(
  'listing_price_history',
  {
    listingId: bigint('listing_id', { mode: 'bigint' })
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    recordedOn: date('recorded_on').notNull(),
    priceEur: numeric('price_eur', { precision: 10, scale: 2 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.listingId, t.recordedOn] }),
    index('listing_price_history_recorded_on_idx').on(t.recordedOn),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type Listing = typeof listings.$inferSelect;
export type NewListing = typeof listings.$inferInsert;
export type MarketSnapshot = typeof marketSnapshots.$inferSelect;
export type NewMarketSnapshot = typeof marketSnapshots.$inferInsert;
export type FlipOpportunity = typeof flipOpportunities.$inferSelect;
export type NewFlipOpportunity = typeof flipOpportunities.$inferInsert;
export type GarageEntry = typeof garage.$inferSelect;
export type WatchlistEntry = typeof watchlist.$inferSelect;
export type AiListing = typeof aiListings.$inferSelect;
export type PriceHistoryRow = typeof listingPriceHistory.$inferSelect;

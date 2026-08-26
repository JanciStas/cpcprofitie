// Sold detection heuristic.
//
// A listing is considered "sold" when:
//   - removed_at IS NOT NULL (URL returned 404/410)
//   - canonical_listing_id IS NULL (it's not a known repost clone)
//   - no other listing with the same fingerprint + source appeared within
//     30 days after removed_at (otherwise it's most likely a relisting)
//
// When we decide it's sold we set sold_at = removed_at. Otherwise we leave
// sold_at NULL so the listing stays out of "days-to-sell" analytics.

import * as Sentry from '@sentry/nextjs';
import { isConnectionError, noteDbUnavailable } from '@/lib/db/errors';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { listings } from '@/lib/db/schema';

export type SoldDetectorStats = {
  scanned: number;
  markedSold: number;
  keptRelisted: number;
  errors: number;
};

type CandidateRow = {
  id: string | number | bigint;
  source: string;
  fingerprint: string | null;
  removed_at: string | Date;
};

export async function detectSoldListings(
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<SoldDetectorStats> {
  const batchSize = opts.batchSize ?? 500;
  const maxBatches = opts.maxBatches ?? 20;
  const db = getDb();
  const stats: SoldDetectorStats = {
    scanned: 0,
    markedSold: 0,
    keptRelisted: 0,
    errors: 0,
  };

  // We iterate by id ascending and advance `cursor` so each batch processes a
  // distinct slice. Because we either set sold_at or leave it NULL forever
  // (relisting verdict is stable once removed_at is fixed), rows we touched
  // in a previous batch won't show up again — but using a cursor avoids
  // unbounded OFFSETs and keeps progress deterministic if we crash midway.
  let cursor = BigInt(0);

  for (let batchNum = 0; batchNum < maxBatches; batchNum++) {
    let rows: CandidateRow[];
    try {
      const result = await db.execute(sql`
        SELECT id, source, fingerprint, removed_at
        FROM ${listings}
        WHERE removed_at IS NOT NULL
          AND sold_at IS NULL
          AND canonical_listing_id IS NULL
          -- No fingerprint means we cannot tell a sale from a repost, so there
          -- is no verdict to reach. Filtered here rather than in the UPDATE on
          -- purpose: these rows never get a verdict, so if they stayed in the
          -- candidate set they would consume the batch budget on every run for
          -- ever, and since the cursor restarts at 0 each time, the scan would
          -- eventually stop reaching genuinely new removals.
          AND fingerprint IS NOT NULL
          -- A car we never observed alive cannot have been observed to sell.
          -- 3 910 of our 4 223 "sales" were listings that were already gone the
          -- first time we fetched them: we imported a URL, the detail page 404'd,
          -- removed_at was set, and this function read that as a sale — average
          -- lifetime 0.21 days. They were never on the market as far as we saw.
          AND first_seen_alive_at IS NOT NULL
          -- ...and it cannot have sold BEFORE we saw it alive. removed_at and
          -- first_seen_alive_at are stamped by different paths (enrichment's
          -- gone branch, the HEAD sweep, the catalogue upsert), so they can
          -- land out of order: a row tombstoned while first_seen_alive_at was
          -- still NULL, then re-sighted and stamped afterwards, ends up with a
          -- negative lifetime. 18 of 940 recorded sales were like this, and on
          -- one subset the median came out at -3.7 days. A duration that runs
          -- backwards is not a noisy measurement, it is a contradiction, and
          -- it must not reach an aggregate.
          AND removed_at >= first_seen_alive_at
          AND id > ${cursor.toString()}::bigint
        ORDER BY id ASC
        LIMIT ${batchSize}
      `);
      rows = result as unknown as CandidateRow[];
    } catch (e) {
      if (isConnectionError(e)) throw noteDbUnavailable(e, { step: 'sold-detector.loadBatch' });
      stats.errors++;
      Sentry.captureException(e, {
        tags: { component: 'sold-detector', step: 'loadBatch' },
      });
      break;
    }

    if (rows.length === 0) break;

    stats.scanned += rows.length;
    const idFragments = rows.map((row) => {
      const idStr = typeof row.id === 'bigint' ? row.id.toString() : String(row.id);
      const idBig = BigInt(idStr);
      if (idBig > cursor) cursor = idBig;
      return sql`${idStr}::bigint`;
    });

    // One set-based UPDATE per batch (was: SELECT + UPDATE per row, up to
    // ~20k queries/run). "Sold" = no relisting with the same fingerprint and
    // source within 30 days either side of removal.
    //
    // Either side, not just after. check-removed walks one seventh of the
    // corpus a day, so removed_at can lag the real removal by up to a week —
    // a seller who deletes and immediately relists produces a repost whose
    // first_seen_at is *earlier* than removed_at. Looking only forwards missed
    // it and called the car sold. Suppressing is the safe direction: a missed
    // sale costs one data point, an invented one corrupts days-to-sell for
    // good, and sold_at is never cleared.
    try {
      const marked = await db.execute(sql`
        UPDATE ${listings} l
        SET sold_at = l.removed_at
        WHERE l.id IN (${sql.join(idFragments, sql`, `)})
          AND l.sold_at IS NULL
          AND l.removed_at IS NOT NULL
          AND l.fingerprint IS NOT NULL
          AND l.first_seen_alive_at IS NOT NULL
          AND l.removed_at >= l.first_seen_alive_at
          AND NOT EXISTS (
            SELECT 1
            FROM ${listings} r
            WHERE r.fingerprint = l.fingerprint
              AND r.id <> l.id
              AND r.source = l.source
              -- A repost is always newer than what it reposts; without this a
              -- listing's own predecessor would count as its successor.
              AND r.first_seen_at > l.first_seen_at
              AND r.first_seen_at BETWEEN (l.removed_at - interval '30 days')
                AND (l.removed_at + interval '30 days')
          )
        RETURNING l.id
      `);
      const markedCount = (marked as unknown as unknown[]).length;
      stats.markedSold += markedCount;
      stats.keptRelisted += rows.length - markedCount;
    } catch (e) {
      // Continuing here would retry the next batch against the same dead
      // server and report a fresh error for each one.
      if (isConnectionError(e)) throw noteDbUnavailable(e, { step: 'sold-detector.processBatch' });
      stats.errors++;
      Sentry.captureException(e, {
        tags: { component: 'sold-detector', step: 'processBatch' },
      });
    }

    console.log(
      `[sold-detector] batch ${batchNum + 1}/${maxBatches} scanned=${stats.scanned} sold=${stats.markedSold} relisted=${stats.keptRelisted} errors=${stats.errors}`,
    );

    if (rows.length < batchSize) break;
  }

  // Running out of batches is not the same as finishing, and the two look
  // identical from the outside: both return a tidy stats object. If the corpus
  // of removed-but-undecided listings outgrows the per-run budget, the tail of
  // it silently stops being examined, and nothing anywhere says so.
  if (stats.scanned >= batchSize * maxBatches) {
    Sentry.captureMessage('sold-detector exhausted its batch budget; removals went unexamined', {
      level: 'warning',
      tags: { component: 'sold-detector' },
      extra: { scanned: stats.scanned, batchSize, maxBatches },
    });
  }

  return stats;
}

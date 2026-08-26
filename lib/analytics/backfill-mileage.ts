// Repeatable backfill: recover mileage from detail descriptions already stored.
//
// Same shape as backfill-year, and the same reason: the bazoš detail page
// carries the odometer while the list page carries a truncated snippet, so
// thousands of cars sit outside every cohort for want of a number that is
// already in the database. No crawling — this re-reads stored text.
//
// The formats the parser had to learn: "116 tis km", "225tis. km",
// "KM:130904", "Km 176000", "182 700 KM". It knew one of them.

import * as Sentry from '@sentry/nextjs';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { extractKmFromStoredText } from '@/lib/scraping/sources/bazos-sk-detail';

export type BackfillMileageStats = {
  scanned: number;
  resolved: number;
  updated: number;
  remaining: number;
  dryRun: boolean;
  /** Only on a dry run: what the extractor read, and the text it read it from.
   *  A mileage is written once and never revisited, so a format misread quietly
   *  files thousands of cars in the wrong band — this makes the result
   *  checkable before anything is committed. */
  sample?: Array<{ id: string; title: string | null; km: number; snippet: string }>;
  /** Highest id scanned this call. Pass back as `afterId` to continue — rows
   *  whose text carries no odometer stay NULL and would otherwise be re-scanned
   *  from the top forever (remaining never reaches 0). */
  nextCursor: string | null;
};

export async function backfillMileage(
  opts: { limit?: number; dryRun?: boolean; afterId?: bigint } = {},
): Promise<BackfillMileageStats> {
  const limit = Math.min(10_000, Math.max(1, opts.limit ?? 5000));
  const dryRun = opts.dryRun ?? false;
  const db = getDb();
  const stats: BackfillMileageStats = {
    scanned: 0,
    resolved: 0,
    updated: 0,
    remaining: 0,
    dryRun,
    nextCursor: null,
  };

  try {
    const rows = (await db.execute(sql`
      SELECT l.id, l.raw_title, d.description
      FROM listings l
      JOIN listing_details d ON d.listing_id = l.id
      WHERE l.mileage_km IS NULL
        AND d.description IS NOT NULL
        AND d.description NOT LIKE '[GONE%'
        ${opts.afterId != null ? sql`AND l.id > ${opts.afterId.toString()}::bigint` : sql``}
      ORDER BY l.id
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string | number | bigint;
      raw_title: string | null;
      description: string;
    }>;

    stats.scanned = rows.length;
    if (rows.length > 0) {
      const last = rows[rows.length - 1]!.id;
      stats.nextCursor = typeof last === 'bigint' ? last.toString() : String(last);
    }

    // Group ids by mileage so one UPDATE covers every listing at that reading rather
    // than one statement per row.
    const byKm = new Map<number, string[]>();
    const sample: NonNullable<BackfillMileageStats['sample']> = [];
    for (const r of rows) {
      const km = extractKmFromStoredText(r.description);
      if (km == null) continue;
      stats.resolved++;
      const idStr = typeof r.id === 'bigint' ? r.id.toString() : String(r.id);
      const arr = byKm.get(km) ?? [];
      arr.push(idStr);
      byKm.set(km, arr);
      // Spread across the batch rather than taking the first 25: the head of a
      // page tends to be one dealer's listings, all in the same format, which
      // would make any sample look unanimous.
      if (dryRun && stats.resolved % 40 === 1 && sample.length < 25) {
        sample.push({
          id: idStr,
          title: r.raw_title,
          km,
          snippet: r.description.replace(/\s+/g, ' ').slice(0, 120),
        });
      }
    }
    if (dryRun) stats.sample = sample;

    if (!dryRun) {
      for (const [km, ids] of byKm) {
        // Re-check mileage_km IS NULL in the predicate so a concurrent scrape that
        // already set it wins — this never overwrites.
        const updated = await db.execute(sql`
          UPDATE listings
          SET mileage_km = ${km}
          WHERE mileage_km IS NULL
            AND id IN (${sql.join(
              ids.map((id) => sql`${id}::bigint`),
              sql`, `,
            )})
          RETURNING id
        `);
        stats.updated += (updated as unknown as unknown[]).length;
      }
    }

    const remainingRows = (await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM listings l
      JOIN listing_details d ON d.listing_id = l.id
      WHERE l.mileage_km IS NULL
        AND d.description IS NOT NULL
        AND d.description NOT LIKE '[GONE%'
    `)) as unknown as Array<{ n: number }>;
    stats.remaining = remainingRows[0]?.n ?? 0;

    return stats;
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'backfill-mileage' } });
    throw e;
  }
}

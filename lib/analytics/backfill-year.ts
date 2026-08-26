// Repeatable backfill: recover `year` from detail descriptions already stored.
//
// Bazoš mostly writes the year two digits — "r.v.: 12/22" — and the detail
// parser only understood four, so 4 779 cars ended up with no year. DealScore
// needs a year, so every one of them sat outside every cohort.
//
// The descriptions are already in listing_details, so this needs no crawling at
// all: it re-runs the (now fixed) extraction over stored text. Same shape as
// backfill-model-id — bounded per call, cursor-driven, fills NULLs only and
// never overwrites a year that is already there.

import * as Sentry from '@sentry/nextjs';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { extractYearFromStoredText } from '@/lib/scraping/sources/bazos-sk-detail';

export type BackfillYearStats = {
  scanned: number;
  resolved: number;
  updated: number;
  remaining: number;
  dryRun: boolean;
  /** Only on a dry run: what the extractor read, and the text it read it from.
   *  A year is written once and never revisited, so a format misread quietly
   *  files thousands of cars under the wrong decade — this makes the result
   *  checkable before anything is committed. */
  sample?: Array<{ id: string; title: string | null; year: number; snippet: string }>;
  /** Highest id scanned this call. Pass back as `afterId` to continue — rows
   *  whose text carries no year stay NULL and would otherwise be re-scanned
   *  from the top forever (remaining never reaches 0). */
  nextCursor: string | null;
};

export async function backfillYear(
  opts: { limit?: number; dryRun?: boolean; afterId?: bigint } = {},
): Promise<BackfillYearStats> {
  const limit = Math.min(10_000, Math.max(1, opts.limit ?? 5000));
  const dryRun = opts.dryRun ?? false;
  const db = getDb();
  const stats: BackfillYearStats = {
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
      WHERE l.year IS NULL
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

    // Group ids by year so one UPDATE covers every listing of that year rather
    // than one statement per row.
    const byYear = new Map<number, string[]>();
    const sample: NonNullable<BackfillYearStats['sample']> = [];
    for (const r of rows) {
      const year = extractYearFromStoredText(r.description, r.raw_title);
      if (year == null) continue;
      stats.resolved++;
      const idStr = typeof r.id === 'bigint' ? r.id.toString() : String(r.id);
      const arr = byYear.get(year) ?? [];
      arr.push(idStr);
      byYear.set(year, arr);
      // Spread across the batch rather than taking the first 25: the head of a
      // page tends to be one dealer's listings, all in the same format, which
      // would make any sample look unanimous.
      if (dryRun && stats.resolved % 40 === 1 && sample.length < 25) {
        sample.push({
          id: idStr,
          title: r.raw_title,
          year,
          snippet: r.description.replace(/\s+/g, ' ').slice(0, 120),
        });
      }
    }
    if (dryRun) stats.sample = sample;

    if (!dryRun) {
      for (const [year, ids] of byYear) {
        // Re-check year IS NULL in the predicate so a concurrent scrape that
        // already set it wins — this never overwrites.
        const updated = await db.execute(sql`
          UPDATE listings
          SET year = ${year}
          WHERE year IS NULL
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
      WHERE l.year IS NULL
        AND d.description IS NOT NULL
        AND d.description NOT LIKE '[GONE%'
    `)) as unknown as Array<{ n: number }>;
    stats.remaining = remainingRows[0]?.n ?? 0;

    return stats;
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'backfill-year' } });
    throw e;
  }
}

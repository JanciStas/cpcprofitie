import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { DbUnavailableError, dbCall } from '@/lib/db/errors';
import { toBigInt } from '@/lib/db/bigint';
import { loadJobCursor, saveJobCursor } from '@/lib/analytics/job-cursor';
import { USER_AGENT } from '@/lib/scraping';
import { classifyHeadResponse } from '@/lib/scraping/liveness';

// HEAD-check cron: asks each listing's own URL whether it is still there.
//
// This is the only signal that distinguishes "gone" from "we have not looked
// lately", so the liquidity numbers are bounded by how much of the corpus it
// actually reaches. It reached almost none of it. Three things were wrong and
// all three are fixed here:
//
//  1. NO DEADLINE. maxDuration is 300s and the loop slept 1.2s per listing
//     while asking for 3 000 of them — an hour of work in a five-minute
//     function. It was killed mid-loop after ~250 checks, every run, and
//     nothing recorded where it stopped. A full sweep of the eligible 70 723
//     would have taken 283 days.
//  2. `id % 7` PARTITIONED BY WEEKDAY. With the loop truncated, the same
//     stalest slice of each bucket was re-checked for ever and the rest of the
//     bucket was never reached at all. A weekday is a fixed coordinate over a
//     population that changes; the backfills solved this already with
//     job_cursors, so this uses the same keyset walk and wraps at the end.
//  3. autobazar.eu WAS EXCLUDED, on the grounds that its sitemap was the
//     canonical liveness signal "handled in the weekly sweep". No step in
//     weekly-maintenance stamps removed_at, so 53 464 listings — 43% of the
//     corpus — were never liveness-checked by anything.
//
// Throughput now comes from interleaving the sources rather than from crawling
// any one of them harder: the 1.2s courtesy delay is what we owe each HOST, so
// three hosts in round-robin do three checks in the time one host does one.
// Each source still sees exactly one request per 1.2s.
// SCHEDULE, reasoned here because vercel.json holds no comments: twice an hour
// at minutes 27 and 57. Enrichment owns minutes 5, 12, 20, 35, 42 and 50, and each of
// those runs can last five minutes, so :57 is the widest gap that leaves this
// run finished before the next one starts. It does brush `unenriched-newest`
// (:55, every four hours) for a couple of minutes six times a day; that is
// accepted because a HEAD every 1.2s per host is a fraction of the load a
// detail-page pass puts on the same host, and the alternative minutes all sit
// closer to something heavier. Colliding streams on one host is not
// theoretical here — it cost four days of autobazar.sk in August.
//
// Both minutes sit clear of enrichment (5, 12, 20, 35, 42, 50) and of
// dispatch-scrape (10, 25, 40). Twice an hour over the narrowed circle of
// 81 632 listings is a full sweep in ~4.6 days, down from 13. Load on any one
// host is unchanged DURING a run — still one request per 1.2s — only the runs
// are more frequent, which is why MAX_BLOCKED_STREAK exists.
//
// Throughput at the previous schedule, MEASURED on the first two production runs
// rather than derived from the delay: 416 and 333 checks per run across the
// three hosts, both ending on their own deadline. Call it ~370/run, ~8 900/day,
// ~3 000 per source per day. Against 46k bazos / 53k eu / 24k sk that is a full
// sweep every ~13 days, not the week the arithmetic suggests -- HEAD latency
// eats into the courtesy delay.
//
// The metric downstream must not claim finer resolution than that number. If
// this comment and reality drift apart, reality wins: read `checked` out of the
// run response before quoting a sweep length anywhere.
export const runtime = 'nodejs';
export const maxDuration = 300;

const PROD = process.env.VERCEL_ENV === 'production';
/** Per-HOST courtesy delay. Not per run — see the round-robin note above. */
const CRAWL_DELAY_MS = 1200;
const HEAD_TIMEOUT_MS = 8000;
/** Leave room to flush and answer before the platform kills the function. */
const DEADLINE_MARGIN_MS = 25_000;
const SOURCES_TO_CHECK = ['bazos.sk', 'autobazar.sk', 'autobazar.eu'] as const;
/** How many rows to pull per source per run. Generous: the deadline, not this,
 *  is what ends a run, and a short queue would idle the round-robin. */
const CANDIDATES_PER_SOURCE = 900;

/**
 * Ceiling on the share of checks in one run that may come back gone.
 *
 * Same reasoning as MAX_GONE_SHARE in enrich.ts, and the same episode behind
 * it: listings do not vanish in bulk, so a run that says they did is describing
 * us — a block, an expired session, a moved URL scheme — and not the market.
 * Marking removed_at is what feeds the sold detector, so the cheap direction to
 * be wrong in is to write nothing and come back next hour.
 */
const MAX_REMOVED_SHARE = 0.3;
const MIN_REMOVED_FOR_GUARD = 20;

/**
 * Consecutive 403/429 from one host before this run gives up on it.
 *
 * The August block arrived with no warning and took autobazar.sk dark for four
 * days. Now that this runs twice an hour it needs its own brake: a source that
 * has said no five times running is not going to say yes on the sixth, and
 * continuing to knock is exactly how the last block was earned. The cursor does
 * not advance past a blocked row, so nothing is skipped — the source is simply
 * asked again next run.
 */
const MAX_BLOCKED_STREAK = 5;

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    if (PROD) {
      return NextResponse.json({ error: 'cron_secret_unset' }, { status: 503 });
    }
  } else {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  try {
    return await run(request);
  } catch (e) {
    // One report per run already went out from noteDbUnavailable().
    if (e instanceof DbUnavailableError) {
      return NextResponse.json({ error: 'db_unavailable' }, { status: 503 });
    }
    Sentry.captureException(e, { tags: { component: 'check-removed', step: 'run' } });
    return NextResponse.json(
      { error: 'check_removed_failed', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

type Candidate = { id: bigint; url: string; source: string; sourceId: string };

async function run(request: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  const db = getDb();
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';
  // 'sweep' asks live listings whether they are still there. 'reverify' asks the
  // opposite question of rows we already wrote off: until 2026-08-26 a 403 was
  // recorded as a removal and the tombstone said only '[GONE]', so 11 473 rows
  // carry a verdict nobody can audit. Re-asking settles each one and hands the
  // flow metric a fortnight of history it would otherwise wait for.
  const mode = url.searchParams.get('mode') === 'reverify' ? 'reverify' : 'sweep';
  const perSource = Number(url.searchParams.get('perSource') ?? String(CANDIDATES_PER_SOURCE));
  const budgetMs = Number(url.searchParams.get('budgetMs') ?? String(maxDuration * 1000));
  const deadline = startedAt + budgetMs - DEADLINE_MARGIN_MS;

  // One independent keyset walk per source, so a big source cannot starve a
  // small one and each wraps on its own schedule.
  const queues: Array<{ source: string; rows: Candidate[]; pos: number; nextAllowedAt: number }> =
    [];
  const cursors: Record<string, { from: string | null; pass: number }> = {};

  for (const source of SOURCES_TO_CHECK) {
    const jobKey = mode === 'reverify' ? `reverify-removed:${source}` : `check-removed:${source}`;
    const { afterId, passNo } = await loadJobCursor(jobKey);
    cursors[source] = { from: afterId == null ? null : afterId.toString(), pass: passNo };
    const candidateSql =
      mode === 'reverify'
        ? sql`
          SELECT l.id, l.url, l.source_id FROM listings l
          JOIN listing_details d ON d.listing_id = l.id
          WHERE l.source = ${source}
            AND l.removed_at IS NOT NULL
            -- Exactly the ambiguous tombstone. A reasoned one ('[GONE:404]')
            -- has already been settled and must not be asked again.
            AND d.description = '[GONE]'
            AND l.id > ${afterId ?? BigInt(0)}
          ORDER BY l.id ASC
          LIMIT ${perSource}
        `
        : sql`
          SELECT id, url, source_id FROM listings
          WHERE source = ${source}
            AND sold_at IS NULL
            AND removed_at IS NULL
            AND canonical_listing_id IS NULL
            -- Only what the flow metric can ever use. HEAD checks are the most
            -- expensive thing we buy, and spending them on rows that can never
            -- reach a cohort stretched a full sweep from 4.6 days to 13.
            --
            -- This is NOT "the rest does not matter": listings with no model and
            -- Czech listings stay in the corpus and enrichment still visits
            -- them. They just do not get the scarce resource. Publishing a
            -- Czech turnover figure would mean widening this FIRST, before any
            -- of it is measured.
            AND is_vehicle
            AND model_id IS NOT NULL
            AND country = 'SK'
            AND id > ${afterId ?? BigInt(0)}
          ORDER BY id ASC
          LIMIT ${perSource}
        `;
    const rows = (await dbCall(
      () => db.execute(candidateSql),
      { step: 'check-removed.loadCandidates' },
    )) as unknown as Array<{ id: string | number | bigint; url: string; source_id: string }>;
    queues.push({
      source,
      rows: rows.map((r) => ({
        id: toBigInt(r.id),
        url: r.url,
        source,
        sourceId: r.source_id,
      })),
      pos: 0,
      nextAllowedAt: 0,
    });
  }

  const stats = {
    checked: 0,
    markedRemoved: 0,
    stillLive: 0,
    errors: 0,
    hitDeadline: false,
    bySource: {} as Record<
      string,
      { checked: number; removed: number; live: number; blocked: number; wrapped: boolean; backedOff: boolean }
    >,
  };
  for (const q of queues) {
    stats.bySource[q.source] = {
      checked: 0,
      removed: 0,
      live: 0,
      blocked: 0,
      wrapped: false,
      backedOff: false,
    };
  }
  const blockedStreak: Record<string, number> = {};

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      cursors,
      queued: Object.fromEntries(queues.map((q) => [q.source, q.rows.length])),
    });
  }

  // Collected, not written as we go: the guard below has to see the whole run
  // before any removed_at is committed. A row we fail to write is re-checked
  // next hour; a row we wrongly write is read as a disappearance first.
  const toRemove: bigint[] = [];
  /** reverify only: rows that answered 200 and must get their life back. */
  const toRestore: bigint[] = [];
  /** Last id actually decided per source — the cursor may only advance to here. */
  const lastDecided: Record<string, bigint | null> = {};
  const exhausted = new Set<string>();

  while (Date.now() < deadline) {
    const ready = queues
      .filter((q) => q.pos < q.rows.length)
      .sort((a, b) => a.nextAllowedAt - b.nextAllowedAt);
    if (ready.length === 0) break;

    const q = ready[0]!;
    const wait = q.nextAllowedAt - Date.now();
    if (wait > 0) {
      if (Date.now() + wait >= deadline) break;
      await sleep(wait);
    }
    const row = q.rows[q.pos]!;
    q.pos += 1;
    q.nextAllowedAt = Date.now() + CRAWL_DELAY_MS;
    if (q.pos >= q.rows.length) exhausted.add(q.source);

    try {
      const res = await fetch(row.url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT },
      });
      stats.checked++;
      stats.bySource[q.source]!.checked++;

      const verdict = classifyHeadResponse(
        res.status,
        res.headers.get('location'),
        row.sourceId,
      );

      if (verdict === 'blocked') {
        // Counted, never written. After enough in a row this source is left
        // alone for the rest of the run — see MAX_BLOCKED_STREAK.
        blockedStreak[q.source] = (blockedStreak[q.source] ?? 0) + 1;
        stats.bySource[q.source]!.blocked++;
        if (blockedStreak[q.source]! >= MAX_BLOCKED_STREAK) {
          q.pos = q.rows.length;
          stats.bySource[q.source]!.backedOff = true;
          Sentry.captureMessage(
            `check-removed backed off ${q.source} after ${MAX_BLOCKED_STREAK} blocks`,
            { level: 'warning', tags: { component: 'check-removed', source: q.source } },
          );
        }
        // The cursor is NOT advanced: a row we were refused has not been
        // decided, and skipping it would put a hole in the sweep.
        continue;
      }
      blockedStreak[q.source] = 0;

      if (verdict === 'gone') {
        toRemove.push(row.id);
        stats.markedRemoved++;
        stats.bySource[q.source]!.removed++;
      } else if (verdict === 'live') {
        await recordLive(db, mode, row.id, toRestore);
        stats.stillLive++;
        stats.bySource[q.source]!.live++;
      }
      // 'unknown' writes nothing but still counts as visited.
      lastDecided[q.source] = row.id;
    } catch (e) {
      // A dead database aborts the run; a listing site that times out does not.
      // Both surface the same socket codes, so only the classified
      // DbUnavailableError from dbCall() is treated as fatal here.
      if (e instanceof DbUnavailableError) throw e;
      stats.errors++;
      // The cursor still advances past a row that errored. Leaving it at the
      // head would let one permanently unreachable URL wedge the whole walk,
      // which is the failure mode the weekday partition already had; the row
      // comes round again on the next pass.
      lastDecided[q.source] = row.id;
      Sentry.captureException(e, {
        tags: { component: 'check-removed', source: q.source },
        extra: { listingId: String(row.id) },
      });
    }
  }
  stats.hitDeadline = Date.now() >= deadline;

  // Disbelieve a run that says the market emptied.
  // Not in reverify: there a high share of 404 is the expected answer, since
  // every row asked was already believed dead. Applying the guard would refuse
  // exactly the batch it was asked to settle.
  const massRemoval =
    mode === 'sweep' &&
    stats.markedRemoved >= MIN_REMOVED_FOR_GUARD &&
    stats.markedRemoved > stats.checked * MAX_REMOVED_SHARE;
  if (massRemoval) {
    const message =
      `${stats.markedRemoved}/${stats.checked} listings reported gone, over the ` +
      `${Math.round(MAX_REMOVED_SHARE * 100)}% ceiling — writing nothing`;
    Sentry.captureMessage(message, { level: 'error', tags: { component: 'check-removed' } });
    // Cursors are not advanced either: nothing here was decided, so the same
    // rows should be asked again rather than skipped.
    return NextResponse.json({ error: 'mass_removal', message, stats }, { status: 502 });
  }

  if (toRemove.length > 0) {
    const ids = sql`ARRAY[${sql.join(
      toRemove.map((id) => sql`${id}`),
      sql`, `,
    )}]::bigint[]`;
    if (mode === 'reverify') {
      // The verdict stands and now carries its reason, so the flow metric will
      // count it. removed_at is left alone: today's 404 confirms the departure
      // happened, not that it happened today, and the original stamp is the
      // better estimate of when.
      //
      // Its own marker, not plain '[GONE:404]', because the two are not equally
      // good evidence. A live sweep learns of a departure within days; these
      // rows were re-asked weeks later, so the WEEK they are filed under can be
      // wrong. Good enough for an overall rate, not for week-over-week
      // movement, and the read side needs to be able to tell them apart to
      // honour that difference.
      await dbCall(
        () =>
          db.execute(sql`
            UPDATE listing_details SET description = '[GONE:reverified]'
            WHERE listing_id = ANY(${ids})
          `),
        { step: 'reverify.confirmGone' },
      );
    } else {
      await dbCall(
        () =>
          db.execute(sql`
            UPDATE listings SET removed_at = coalesce(removed_at, now())
            WHERE id = ANY(${ids})
          `),
        { step: 'check-removed.markRemoved' },
      );
    }
  }

  if (toRestore.length > 0) {
    // Written off by mistake — almost certainly a 403 read as a deletion. Both
    // stamps are cleared and the tombstone is dropped so enrichment picks the
    // listing up again as an ordinary row.
    const ids = sql`ARRAY[${sql.join(
      toRestore.map((id) => sql`${id}`),
      sql`, `,
    )}]::bigint[]`;
    await dbCall(
      () =>
        db.execute(sql`
          UPDATE listings
          SET removed_at = NULL, sold_at = NULL,
              last_seen_at = now(),
              first_seen_alive_at = coalesce(first_seen_alive_at, now())
          WHERE id = ANY(${ids})
        `),
      { step: 'reverify.restore' },
    );
    await dbCall(
      () =>
        db.execute(sql`
          DELETE FROM listing_details
          WHERE listing_id = ANY(${ids}) AND description = '[GONE]'
        `),
      { step: 'reverify.dropTombstone' },
    );
  }

  // Advance each source's cursor to the last row it actually decided. A source
  // whose queue ran out has reached the end of the table: reset it so the next
  // pass starts from the top, exactly as the backfills do.
  for (const q of queues) {
    // Backing off empties the queue by design, which must not be mistaken for
    // reaching the end of the table — wrapping there would skip everything
    // after the blocked row until the next full pass.
    const wrapped = exhausted.has(q.source) && !stats.bySource[q.source]!.backedOff;
    stats.bySource[q.source]!.wrapped = wrapped;
    const last = lastDecided[q.source];
    if (wrapped) {
      await saveJobCursor(`check-removed:${q.source}`, null);
    } else if (last != null) {
      await saveJobCursor(`check-removed:${q.source}`, last.toString());
    }
  }

  const tooManyErrors = stats.checked > 0 && stats.errors > stats.checked / 2;
  return NextResponse.json(
    {
      runAt: new Date().toISOString(),
      mode,
      restored: toRestore.length,
      elapsedMs: Date.now() - startedAt,
      stats,
    },
    { status: tooManyErrors ? 502 : 200 },
  );
}

/**
 * Record direct evidence the listing is still there.
 *
 * first_seen_alive_at is coalesced, not overwritten: without it a listing only
 * ever seen by this sweep would look "never observed alive" and its eventual
 * departure could not be read at all.
 */
/**
 * Live verdict. In a sweep that is written immediately; in reverify it is
 * collected, because restoring a row also has to drop its tombstone and both
 * halves should land together.
 */
async function recordLive(
  db: ReturnType<typeof getDb>,
  mode: 'sweep' | 'reverify',
  id: bigint,
  toRestore: bigint[],
): Promise<void> {
  if (mode === 'reverify') {
    toRestore.push(id);
    return;
  }
  await markLive(db, id);
}

async function markLive(db: ReturnType<typeof getDb>, id: bigint): Promise<void> {
  await dbCall(
    () =>
      db.execute(sql`
        UPDATE listings
        SET last_seen_at = now(),
            first_seen_alive_at = coalesce(first_seen_alive_at, now())
        WHERE id = ${id}
      `),
    { step: 'check-removed.markLive' },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

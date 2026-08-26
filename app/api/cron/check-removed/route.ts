import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { DbUnavailableError, dbCall } from '@/lib/db/errors';
import { toBigInt } from '@/lib/db/bigint';
import { loadJobCursor, saveJobCursor } from '@/lib/analytics/job-cursor';
import { USER_AGENT } from '@/lib/scraping';

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
// SCHEDULE, reasoned here because vercel.json holds no comments: hourly at
// minute 57. Enrichment owns minutes 5, 12, 20, 35, 42 and 50, and each of
// those runs can last five minutes, so :57 is the widest gap that leaves this
// run finished before the next one starts. It does brush `unenriched-newest`
// (:55, every four hours) for a couple of minutes six times a day; that is
// accepted because a HEAD every 1.2s per host is a fraction of the load a
// detail-page pass puts on the same host, and the alternative minutes all sit
// closer to something heavier. Colliding streams on one host is not
// theoretical here — it cost four days of autobazar.sk in August.
//
// Throughput at this schedule: ~24 runs x ~200 checks per host = ~4 800 per
// host per day, so all three sources come round in roughly a week. The metric
// downstream must not claim finer resolution than that.
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

type Candidate = { id: bigint; url: string; source: string };

async function run(request: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  const db = getDb();
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';
  const perSource = Number(url.searchParams.get('perSource') ?? String(CANDIDATES_PER_SOURCE));
  const budgetMs = Number(url.searchParams.get('budgetMs') ?? String(maxDuration * 1000));
  const deadline = startedAt + budgetMs - DEADLINE_MARGIN_MS;

  // One independent keyset walk per source, so a big source cannot starve a
  // small one and each wraps on its own schedule.
  const queues: Array<{ source: string; rows: Candidate[]; pos: number; nextAllowedAt: number }> =
    [];
  const cursors: Record<string, { from: string | null; pass: number }> = {};

  for (const source of SOURCES_TO_CHECK) {
    const jobKey = `check-removed:${source}`;
    const { afterId, passNo } = await loadJobCursor(jobKey);
    cursors[source] = { from: afterId == null ? null : afterId.toString(), pass: passNo };
    const rows = (await dbCall(
      () =>
        db.execute(sql`
          SELECT id, url FROM listings
          WHERE source = ${source}
            AND sold_at IS NULL
            AND removed_at IS NULL
            AND canonical_listing_id IS NULL
            AND id > ${afterId ?? BigInt(0)}
          ORDER BY id ASC
          LIMIT ${perSource}
        `),
      { step: 'check-removed.loadCandidates' },
    )) as unknown as Array<{ id: string | number | bigint; url: string }>;
    queues.push({
      source,
      rows: rows.map((r) => ({ id: toBigInt(r.id), url: r.url, source })),
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
    bySource: {} as Record<string, { checked: number; removed: number; live: number; wrapped: boolean }>,
  };
  for (const q of queues) {
    stats.bySource[q.source] = { checked: 0, removed: 0, live: 0, wrapped: false };
  }

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
      if (res.status === 404 || res.status === 410) {
        toRemove.push(row.id);
        stats.markedRemoved++;
        stats.bySource[q.source]!.removed++;
      } else if (res.status >= 200 && res.status < 400) {
        await dbCall(
          () =>
            db.execute(sql`
              UPDATE listings
              SET last_seen_at = now(),
                  -- A 2xx on the listing's own URL is direct evidence it is
                  -- still there. Without this, a listing only ever checked by
                  -- this sweep would look "never observed alive" and its
                  -- eventual disappearance could not be read at all.
                  first_seen_alive_at = coalesce(first_seen_alive_at, now())
              WHERE id = ${row.id}
            `),
          { step: 'check-removed.markLive' },
        );
        stats.stillLive++;
        stats.bySource[q.source]!.live++;
      }
      // 403 and 5xx fall through deliberately: they say the source is unhappy
      // with us, which is not evidence about the car. Same call as enrich.ts.
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
  const massRemoval =
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
    await dbCall(
      () =>
        db.execute(sql`
          UPDATE listings SET removed_at = coalesce(removed_at, now())
          WHERE id = ANY(${sql`ARRAY[${sql.join(
            toRemove.map((id) => sql`${id}`),
            sql`, `,
          )}]::bigint[]`})
        `),
      { step: 'check-removed.markRemoved' },
    );
  }

  // Advance each source's cursor to the last row it actually decided. A source
  // whose queue ran out has reached the end of the table: reset it so the next
  // pass starts from the top, exactly as the backfills do.
  for (const q of queues) {
    const wrapped = exhausted.has(q.source);
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
    { runAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, stats },
    { status: tooManyErrors ? 502 : 200 },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

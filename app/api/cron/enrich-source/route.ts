import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { DbUnavailableError, isConnectionError, noteDbUnavailable } from '@/lib/db/errors';
import { getSource } from '@/lib/scraping';
import { loadUnenrichedBatch, type EnrichSelectMode } from '@/lib/scraping/enrich-batch-loader';
import { MassGoneError, persistDetails, runEnrichment } from '@/lib/scraping';
import { loadJobCursor, saveJobCursor } from '@/lib/analytics/job-cursor';
import { ALL_SOURCES, type Source } from '@/lib/scraping';
import { pickSource } from '@/lib/scraping/rotation';

// Server-side detail enrichment for a single source. Each invocation runs as
// many batches as fit in the 280s budget (≈ 200 listings).
//
// SCHEDULE, and why it is what it is (vercel.json cannot hold comments).
//
// This used to be seven runs a day for all three sources together: roughly
// 1 400 rows, against an intake that reached 10 766 in a single day during a
// deep catalogue cycle. The backlog therefore only ever grew -- it sat at
// 16 318 -- and the corpus only filled in while somebody sat and drove a loop
// by hand. It is now twice an hour per source on staggered minutes, about
// 9 600 rows a day, which drains the backlog and stays ahead of intake.
//
// Deliberately staggered, and deliberately NOT partitioned. enrich.ts paces
// itself at >= 1.5s per fetch, but that budget is per process: three parallel
// streams send three times as fast and the host cannot know the others exist.
// Three streams plus a full catalogue walk is exactly what got the Vercel
// egress IP refused by autobazar.sk for four days. One source touched for
// ~280s twice an hour is around 0.1 requests a second averaged out.
export const runtime = 'nodejs';
export const maxDuration = 300;

const PROD = process.env.VERCEL_ENV === 'production';
// Smaller batches mean more frequent deadline checks. Real-world detail
// page fetches take 3-10s (not just the 1.2s crawl delay) so a batch of 10
// fits in ~60s and we get 3-4 batches per 220s budget.
const BATCH_SIZE = 10;
const DELAY_MS = 1200;
const TIME_BUDGET_MS = 220_000;

export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    if (PROD) return NextResponse.json({ error: 'cron_secret_unset' }, { status: 503 });
  } else {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  let payload: {
    source?: string;
    partition?: number;
    modulo?: number;
    mode?: string;
    afterId?: string;
  } = {};
  // Vercel Cron issues a GET with no body, so parameters have to be readable
  // from the query string too. Kept POST+body working for the driver script,
  // which loops until { done: true }.
  const qs = new URL(request.url).searchParams;
  if (request.method === 'GET') {
    payload = {
      source: qs.get('source') ?? undefined,
      mode: qs.get('mode') ?? undefined,
      afterId: qs.get('afterId') ?? undefined,
      partition: qs.get('partition') ? Number(qs.get('partition')) : undefined,
      modulo: qs.get('modulo') ? Number(qs.get('modulo')) : undefined,
    };
  } else {
    try {
      payload = await request.json();
    } catch {
      return NextResponse.json({ error: 'bad_json' }, { status: 400 });
    }
  }
  if (!payload.source) {
    // Rotate by the clock when the cron does not name one, so no source is
    // permanently last in line — the failure that made bazos.sk disappear.
    payload.source = pickSource(ALL_SOURCES, new Date());
  }
  const sourceId = payload.source;
  // 'null-price' / 'null-model' re-fetch detail pages for active listings
  // still missing a price / model (backfill); default 'unenriched' keeps the
  // normal first-pass flow.
  const mode: EnrichSelectMode =
    payload.mode === 'null-vin'
      ? 'null-vin'
      : payload.mode === 'null-description'
      ? 'null-description'
      : payload.mode === 'null-price'
      ? 'null-price'
      : payload.mode === 'null-country'
        ? 'null-country'
      : payload.mode === 'null-locality'
        ? 'null-locality'
      : payload.mode === 'null-model'
        ? 'null-model'
        : payload.mode === 'unenriched-newest'
          ? 'unenriched-newest'
          : 'unenriched';
  // Cursor-driven modes: rows that stay NULL even after a successful fetch
  // (gone pages, adverts with no price) sit at the head of the set and would
  // be re-fetched on every invocation without one.
  const isBackfill =
    mode === 'null-price' ||
    mode === 'null-model' ||
    mode === 'null-locality' ||
    mode === 'null-country' ||
    mode === 'null-vin' ||
    mode === 'null-description';
  // Cursor carried across invocations so the driver walks the whole backfill
  // set once. Without it, rows that stay NULL after enrichment (Cena dohodou,
  // gone) sit at the head and every invocation re-fetches them → livelock.
  let cursor: bigint | undefined = undefined;
  if (isBackfill && typeof payload.afterId === 'string' && /^\d+$/.test(payload.afterId)) {
    cursor = BigInt(payload.afterId);
  }
  // A cron cannot hand its own cursor back, so a scheduled backfill reads it
  // from job_cursors instead -- the same fix that got the other backfills
  // scheduled at all. An explicit ?afterId still wins, so the driver scripts
  // behave exactly as before, and a dry run never moves it.
  const useJobCursor = isBackfill && cursor == null && payload.afterId == null;
  const jobKey = `enrich:${sourceId}:${mode}`;
  if (useJobCursor) {
    const { afterId } = await loadJobCursor(jobKey);
    if (afterId != null) cursor = afterId;
  }
  // Optional id-based partitioning so N shells can run in parallel on
  // disjoint id subsets.
  const partition =
    typeof payload.partition === 'number' &&
    typeof payload.modulo === 'number' &&
    payload.modulo > 1 &&
    payload.partition >= 0 &&
    payload.partition < payload.modulo
      ? { index: payload.partition, modulo: payload.modulo }
      : undefined;
  if (!sourceId || !ALL_SOURCES.includes(sourceId as Source)) {
    return NextResponse.json({ error: 'invalid_source', valid: ALL_SOURCES }, { status: 400 });
  }
  const source = getSource(sourceId as Source);
  if (!source.detailUrl || !source.parseDetailPage) {
    return NextResponse.json({ error: 'source_has_no_detail_parser' }, { status: 400 });
  }

  const startedAt = Date.now();
  const deadline = startedAt + TIME_BUDGET_MS;
  let totalFetched = 0;
  let totalDetails = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let batches = 0;
  let done = false;
  const sampleErrors: string[] = [];

  while (Date.now() < deadline) {
    let batch;
    try {
      batch = await loadUnenrichedBatch(sourceId as Source, BATCH_SIZE, partition, mode, cursor);
    } catch (e) {
      if (isConnectionError(e)) {
        noteDbUnavailable(e, { step: 'enrich-source.loadBatch', source: sourceId });
        return NextResponse.json({ error: 'db_unavailable' }, { status: 503 });
      }
      Sentry.captureException(e, {
        tags: { component: 'enrich-source', step: 'loadBatch', source: sourceId },
      });
      return NextResponse.json(
        { error: 'load_batch_failed', message: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
    if (batch.length === 0) {
      done = true;
      break;
    }
    batches++;
    // Advance the backfill cursor past this batch (rawPayload.__cursorId).
    if (isBackfill) {
      const lastId = batch[batch.length - 1]?.rawPayload?.__cursorId;
      if (typeof lastId === 'string') cursor = BigInt(lastId);
    }
    try {
      const result = await runEnrichment(source, batch, {
        limit: BATCH_SIZE,
        delayMs: DELAY_MS,
      });
      // Count what reached the database, not what came back from the parser.
      // These used to be the same number, so a run that persisted nothing still
      // reported full success — 3 000 "details" against 221 actual rows.
      if (result.details.length > 0) {
        const saved = await persistDetails(result.details);
        totalDetails += saved.detailsUpserted;
        totalSkipped += saved.skipped;
      }
      totalFetched += result.fetched;
      totalErrors += result.errors.length;
      for (const e of result.errors) {
        if (sampleErrors.length < 5) sampleErrors.push(e);
      }
    } catch (e) {
      // Enrichment does HTTP as well as DB work, so only the classified DB
      // outage stops the loop — a slow detail page must not.
      if (e instanceof DbUnavailableError) {
        return NextResponse.json({ error: 'db_unavailable', batches }, { status: 503 });
      }
      // A batch that came back mostly gone means the source changed or is
      // blocking us. Carrying on would keep hammering it and keep asking the
      // same question, so stop this source for this invocation and report the
      // run as failed — silently continuing is how the earlier version turned
      // one bad afternoon into 3 676 listings marked removed.
      if (e instanceof MassGoneError) {
        Sentry.captureException(e, {
          tags: { component: 'enrich-source', step: 'massGone', source: sourceId },
        });
        return NextResponse.json(
          { error: 'mass_gone', message: e.message, source: sourceId, batches, totalDetails },
          { status: 502 },
        );
      }
      totalErrors++;
      Sentry.captureException(e, {
        tags: { component: 'enrich-source', step: 'runEnrichment', source: sourceId },
      });
      // Don't fail the whole invocation — log and continue to the next batch.
    }
  }

  // Saved after the work, not before: a run that dies mid-batch should redo the
  // slice rather than skip it. `done` resets the cursor and bumps pass_no, so
  // rows that never yield a VIN are revisited on the next pass instead of
  // wedging the walk at the head of the set.
  if (useJobCursor) {
    await saveJobCursor(jobKey, done ? null : (cursor?.toString() ?? null));
  }

  return NextResponse.json({
    source: sourceId,
    done,
    batches,
    totalFetched,
    totalDetails,
    totalSkipped,
    totalErrors,
    sampleErrors,
    // The driver must send this back as `afterId` next invocation so the walk
    // continues past rows already visited (backfill modes only).
    nextCursor: isBackfill && cursor != null ? cursor.toString() : undefined,
    jobCursor: useJobCursor ? (done ? null : (cursor?.toString() ?? null)) : undefined,
    elapsedMs: Date.now() - startedAt,
  });
}

// Vercel Cron sends GET; the driver script sends POST with a body. Both land
// here.
export const GET = POST;

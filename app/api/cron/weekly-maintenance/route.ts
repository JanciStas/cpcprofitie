import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { isConnectionError, noteDbUnavailable } from '@/lib/db/errors';
import { backfillFingerprints, clusterReposts } from '@/lib/dedup/cluster';
import { computeFlipOpportunities } from '@/lib/analytics/flip-opportunities';
import { computeWeeklySnapshots } from '@/lib/analytics/snapshots';
import { computeWeeklyFlow, computeWeeklyPriceFlow } from '@/lib/analytics/liquidity';

// Weekly maintenance cron — runs Sunday 02:00 UTC. Five sequential steps,
// each wrapped in try/catch + Sentry so one failing step doesn't abort the
// rest. Scheduled in vercel.ts as `0 2 * * 0` (Pro plan).
//
// Steps:
//   1. Backfill fingerprints for listings that don't have one yet
//   2. Cluster reposts (VIN-first, fingerprint fallback) → mark canonical_listing_id
//   3. Compute weekly market_snapshots per cohort
//   4. Compute flip_opportunities for active canonical listings
//
// Sitemap re-sweep is handled by the existing 6h dispatch-scrape cron, which
// also runs Sunday morning, so we don't duplicate that work here.
export const runtime = 'nodejs';
export const maxDuration = 300;

const PROD = process.env.VERCEL_ENV === 'production';

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

  const url = new URL(request.url);
  const fingerprintLimit = Number(url.searchParams.get('fingerprintLimit') ?? '10000');
  const summary: Record<string, unknown> = {};
  const errors: string[] = [];

  try {
    const updated = await backfillFingerprints({ limit: fingerprintLimit });
    summary.backfillFingerprints = { updated };
  } catch (e) {
    if (isConnectionError(e)) {
      noteDbUnavailable(e, { step: 'weekly-maintenance.backfillFingerprints' });
      return NextResponse.json({ error: 'db_unavailable', summary, errors }, { status: 503 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`backfillFingerprints: ${msg}`);
    Sentry.captureException(e, {
      tags: { component: 'weekly-maintenance', step: 'backfillFingerprints' },
    });
  }

  try {
    const stats = await clusterReposts({ windowDays: 90 });
    summary.clusterReposts = stats;
  } catch (e) {
    if (isConnectionError(e)) {
      noteDbUnavailable(e, { step: 'weekly-maintenance.clusterReposts' });
      return NextResponse.json({ error: 'db_unavailable', summary, errors }, { status: 503 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`clusterReposts: ${msg}`);
    Sentry.captureException(e, {
      tags: { component: 'weekly-maintenance', step: 'clusterReposts' },
    });
  }

  try {
    const stats = await computeWeeklySnapshots();
    summary.computeWeeklySnapshots = stats;
  } catch (e) {
    if (isConnectionError(e)) {
      noteDbUnavailable(e, { step: 'weekly-maintenance.computeWeeklySnapshots' });
      return NextResponse.json({ error: 'db_unavailable', summary, errors }, { status: 503 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`computeWeeklySnapshots: ${msg}`);
    Sentry.captureException(e, {
      tags: { component: 'weekly-maintenance', step: 'computeWeeklySnapshots' },
    });
  }

  try {
    // Flow before flips so the week's exposure is on disk even if the flip pass
    // fails. Two statements: the price half only updates rows the flow half
    // created, because price movement with no exposure beside it has no
    // denominator and is not publishable on its own.
    const stats = await computeWeeklyFlow();
    const pricedRows = await computeWeeklyPriceFlow();
    summary.computeWeeklyFlow = { ...stats, pricedRows };
  } catch (e) {
    if (isConnectionError(e)) {
      noteDbUnavailable(e, { step: 'weekly-maintenance.computeWeeklyFlow' });
      return NextResponse.json({ error: 'db_unavailable', summary, errors }, { status: 503 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`computeWeeklyFlow: ${msg}`);
    Sentry.captureException(e, {
      tags: { component: 'weekly-maintenance', step: 'computeWeeklyFlow' },
    });
  }

  try {
    const stats = await computeFlipOpportunities();
    summary.computeFlipOpportunities = stats;
  } catch (e) {
    if (isConnectionError(e)) {
      noteDbUnavailable(e, { step: 'weekly-maintenance.computeFlipOpportunities' });
      return NextResponse.json({ error: 'db_unavailable', summary, errors }, { status: 503 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`computeFlipOpportunities: ${msg}`);
    Sentry.captureException(e, {
      tags: { component: 'weekly-maintenance', step: 'computeFlipOpportunities' },
    });
  }

  return NextResponse.json(
    {
      runAt: new Date().toISOString(),
      summary,
      errors,
      ok: errors.length === 0,
    },
    { status: errors.length > 0 ? 500 : 200 },
  );
}

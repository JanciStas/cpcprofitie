import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { isAdminRequestOrigin, isAdminUser } from '@/lib/auth/admin';
import { getCurrentUser } from '@/lib/auth/server';
import { refreshFingerprints } from '@/lib/dedup/cluster';

// Recompute every listing fingerprint from the row as it stands now.
//
// The old backfill only filled blanks, and persist.ts pins a value at scrape
// time, so no row was ever blank and the recompute never ran — for anything.
// Auth: admin session OR CRON_SECRET bearer. Bounded per call; loop on
// nextCursor until scanned is 0. ?dryRun=1 returns a before/after sample
// without writing.
//
// Read that sample before running it for real, and check one thing above all:
// bazoš fingerprints must NOT come out one-per-listing. If they do, the photo
// identity rule has regressed and sold-detector would mark the whole source
// sold.
export const runtime = 'nodejs';
export const maxDuration = 300;

async function authorize(request: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (secret && auth === `Bearer ${secret}`) return true;
  const user = await getCurrentUser();
  return isAdminUser(user) && isAdminRequestOrigin(request);
}

export async function GET(request: Request) {
  if (!(await authorize(request))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
  // Pass ?afterId=<nextCursor> from the previous response to continue the walk.
  const afterIdParam = url.searchParams.get('afterId');
  const afterId = afterIdParam && /^\d+$/.test(afterIdParam) ? BigInt(afterIdParam) : undefined;

  const startedAt = Date.now();
  try {
    const stats = await refreshFingerprints({ dryRun, limit, afterId });
    return NextResponse.json({ stats, elapsedMs: Date.now() - startedAt });
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'refresh-fingerprints-api' } });
    return NextResponse.json(
      { error: 'refresh_failed', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export const POST = GET;

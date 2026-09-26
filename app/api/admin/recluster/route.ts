import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { clusterReposts, resetCanonical } from '@/lib/dedup/cluster';
import { isAdminRequestOrigin, isAdminUser } from '@/lib/auth/admin';
import { getCurrentUser } from '@/lib/auth/server';

// Re-run repost clustering. Auth: admin session OR CRON_SECRET bearer.
// `?reset=1` first clears all canonical_listing_id, so the guarded fingerprint
// pass recomputes the whole graph — needed once to purge the false-merges the
// old unguarded pass created (an 11k-clone monster cluster). Without reset it
// only clusters newly-eligible rows (idempotent top-up).
export const runtime = 'nodejs';
export const maxDuration = 300;

const PROD = process.env.VERCEL_ENV === 'production';

async function authorize(request: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (secret && auth === `Bearer ${secret}`) return true;
  const user = await getCurrentUser();
  return isAdminUser(user) && isAdminRequestOrigin(request);
}

export async function POST(request: Request) {
  if (!(await authorize(request))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!process.env.CRON_SECRET && PROD) {
    return NextResponse.json({ error: 'cron_secret_unset' }, { status: 503 });
  }

  const url = new URL(request.url);
  const reset = url.searchParams.get('reset') === '1';
  const startedAt = Date.now();
  try {
    let resetCount = 0;
    if (reset) resetCount = await resetCanonical();
    const stats = await clusterReposts({ windowDays: 90 });
    return NextResponse.json({ reset, resetCount, stats, elapsedMs: Date.now() - startedAt });
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'recluster' } });
    return NextResponse.json(
      { error: 'recluster_failed', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export const GET = POST;

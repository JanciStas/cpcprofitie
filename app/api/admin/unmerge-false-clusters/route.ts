import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { isAdminRequestOrigin, isAdminUser } from '@/lib/auth/admin';
import { getCurrentUser } from '@/lib/auth/server';
import { unmergeFalseClusters } from '@/lib/dedup/unmerge-false-clusters';

// Clear duplicate links that nothing justifies any more.
//
// Run AFTER refresh-fingerprints: this compares a clone with its canonical,
// so it is only as good as the fingerprints it reads. Auth: admin session OR
// CRON_SECRET bearer. Bounded per call; loop on nextCursor. ?dryRun=1 returns
// up to 50 pairs — read them, every pair should be visibly two different cars.
//
// One-way and idempotent: it only ever clears a link, and a second run finds
// nothing. clusterReposts rebuilds whatever is genuinely a repost.
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
    const stats = await unmergeFalseClusters({ dryRun, limit, afterId });
    return NextResponse.json({ stats, elapsedMs: Date.now() - startedAt });
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'unmerge-false-clusters-api' } });
    return NextResponse.json(
      { error: 'unmerge_failed', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export const POST = GET;

import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { isAdminEmail } from '@/lib/auth/admin';
import { loadJobCursor, saveJobCursor } from '@/lib/analytics/job-cursor';
import { getCurrentUser } from '@/lib/auth/server';
import { classifyVehicles } from '@/lib/analytics/classify-vehicles';

// Mark listings that are car parts, not cars — a bumper sold under "Škoda
// Octavia" is filed as an Octavia and lands in that cohort's median.
// Title-only, so no crawling. Auth: admin session OR CRON_SECRET bearer.
// Bounded per call — loop until stats.remaining is 0. `?dryRun=1` classifies
// without writing and returns samples; `?limit=N` caps the batch.
//
// Read stats.flaggedWithYearAndKm before running this for real: a part almost
// never carries both, so anything above a trickle means the word list is
// catching cars. The write is one-way — nothing reinstates a listing.
export const runtime = 'nodejs';
export const maxDuration = 300;

async function authorize(request: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (secret && auth === `Bearer ${secret}`) return true;
  const user = await getCurrentUser();
  return isAdminEmail(user?.email);
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
  const explicitAfterId =
    afterIdParam && /^\d+$/.test(afterIdParam) ? BigInt(afterIdParam) : undefined;
  // Same reason as the other backfills: a cron cannot carry the cursor itself.
  const persisted = explicitAfterId == null ? await loadJobCursor('classify-vehicles') : null;
  const afterId = explicitAfterId ?? persisted?.afterId ?? undefined;

  const startedAt = Date.now();
  try {
    const stats = await classifyVehicles({ dryRun, limit, afterId });
    if (!dryRun && explicitAfterId == null) {
      await saveJobCursor('classify-vehicles', stats.nextCursor);
    }
    return NextResponse.json({
      stats,
      pass: persisted?.passNo ?? null,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'classify-vehicles-api' } });
    return NextResponse.json(
      { error: 'backfill_failed', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export const POST = GET;

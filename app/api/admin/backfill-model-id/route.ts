import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { isAdminEmail } from '@/lib/auth/admin';
import { loadJobCursor, saveJobCursor } from '@/lib/analytics/job-cursor';
import { getCurrentUser } from '@/lib/auth/server';
import { backfillModelId } from '@/lib/analytics/backfill-model-id';

// Resolve model_id for historical listings that have a title but no model_id
// (starves DealScore cohorts). Auth: admin session OR CRON_SECRET bearer.
// Bounded per call — loop until stats.remaining is 0. `?dryRun=1` resolves
// without writing; `?limit=N` caps the batch.
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
  // A cron fires the same URL every time, so with no cursor it would repeat
  // the first batch for ever. An explicit ?afterId still wins, which keeps the
  // hand-driven scripts working exactly as before.
  const persisted = explicitAfterId == null ? await loadJobCursor('backfill-model-id') : null;
  const afterId = explicitAfterId ?? persisted?.afterId ?? undefined;

  const startedAt = Date.now();
  try {
    const stats = await backfillModelId({ dryRun, limit, afterId });
    // Only the scheduled path owns the cursor. A dry run must not move it, and
    // neither must a manual call that passed its own position.
    if (!dryRun && explicitAfterId == null) {
      await saveJobCursor('backfill-model-id', stats.nextCursor);
    }
    return NextResponse.json({
      stats,
      pass: persisted?.passNo ?? null,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'backfill-model-id-api' } });
    return NextResponse.json(
      { error: 'backfill_failed', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export const POST = GET;

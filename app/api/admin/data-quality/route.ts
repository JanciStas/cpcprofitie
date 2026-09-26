import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { isAdminRequestOrigin, isAdminUser } from '@/lib/auth/admin';
import { getCurrentUser } from '@/lib/auth/server';
import { getDataQualityReport } from '@/lib/db/queries/data-quality';

// Read-only data-quality metrics. Two ways to authorize:
//   - a logged-in admin (ADMIN_EMAILS) hitting it from the app, or
//   - Authorization: Bearer <CRON_SECRET> for scripted/ops measurement
//     (the admin page uses a cookie session; ops tooling can't, so it needs
//     the bearer path).
export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

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
  try {
    const report = await getDataQualityReport();
    return NextResponse.json(report, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'data-quality-api' } });
    return NextResponse.json(
      { error: 'report_failed', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

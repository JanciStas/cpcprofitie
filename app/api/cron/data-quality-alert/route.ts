import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import * as Sentry from '@sentry/nextjs';
import {
  getDataQualityReport,
  pickClusterAlerts,
  pickCountryCoverageAlerts,
  pickDriftAlerts,
  pickFreshnessAlerts,
} from '@/lib/db/queries/data-quality';

// Daily data-quality watchdog (08:00 UTC via vercel.json). Runs the read-only
// data-quality report and raises a Sentry warning when any source's key-field
// coverage looks like selector drift (health 'drift') or is degraded ('warn').
// This is what turns "autobazar.sk price went 100% null" from a months-later
// discovery into a same-day alert.
export const runtime = 'nodejs';
export const maxDuration = 60;

const PROD = process.env.VERCEL_ENV === 'production';

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    if (PROD) return NextResponse.json({ error: 'cron_secret_unset' }, { status: 503 });
  } else {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const startedAt = Date.now();
  try {
    const report = await getDataQualityReport();
    // A blind watchdog is worse than a loud one: getDataQualityReport swallows
    // its own DB errors and returns an all-zeros report, which pickDriftAlerts
    // reads as "no sources, nothing to alert". Catch that here so a DB outage
    // pages instead of silently reporting driftCount=0.
    if (!report.ok) {
      Sentry.captureMessage('Data-quality watchdog blind: report failed to compute', {
        level: 'error',
        tags: { component: 'data-quality-alert' },
      });
      return NextResponse.json(
        { error: 'report_failed', elapsedMs: Date.now() - startedAt },
        { status: 500 },
      );
    }

    // Push the fresh numbers to the public page.
    //
    // /status wraps the same report in unstable_cache with revalidate: 600 and
    // that expiry did not fire: on 2026-09-01 the page was still serving the
    // report generated on 2026-08-26 at 00:07, six days old, claiming bazos.sk
    // was 35.9% price-less when it was 37.7% and that autobazar.eu prices were
    // 59.7% inside SLA when they were 6.1%. A status page that is confidently
    // wrong is worse than one that admits it does not know.
    //
    // This watchdog already computes the identical report, so tagging it here
    // caps staleness at one day regardless of whether the timer ever works.
    // The page also shows the age now, so a gap is visible rather than implied.
    // Two arguments, per the Next 16 reference: the single-argument form is
    // deprecated. 'max' marks the entry stale and lets the next visitor take
    // fresh data through stale-while-revalidate. updateTag would expire it
    // outright but is Server-Actions-only, so it is not available here.
    revalidateTag('data-health', 'max');
    // Dedup defects are reported at error level, not warning. Selector drift
    // makes new rows worse; a false merge makes existing rows disappear from
    // the market, and nothing notices because the listings still exist. 13 631
    // of them were hidden for weeks while every dashboard read green.
    const clusterAlerts = pickClusterAlerts(report);
    if (clusterAlerts.length > 0) {
      Sentry.captureMessage(
        `Dedup poškodený: ${clusterAlerts.map((a) => `${a.reason} (${a.count})`).join('; ')}`,
        { level: 'error', tags: { component: 'data-quality-alert' }, extra: { clusterAlerts } },
      );
    }

    // Stale prices are a correctness failure that looks like nothing at all:
    // the listings are still there, the dashboards still render, and the
    // answers are quietly out of date. The crawler re-read 600 of 78 775
    // listings per run for months and no signal anywhere said so.
    const freshnessAlerts = pickFreshnessAlerts(report);
    const staleErrors = freshnessAlerts.filter((a) => a.level === 'error');
    if (staleErrors.length > 0) {
      Sentry.captureMessage(
        `Ceny starnú: ${staleErrors.map((a) => `${a.source} (${a.reason})`).join('; ')}`,
        { level: 'error', tags: { component: 'data-quality-alert' }, extra: { freshnessAlerts } },
      );
    } else if (freshnessAlerts.length > 0) {
      Sentry.captureMessage(
        `Čerstvosť klesá: ${freshnessAlerts.map((a) => a.source).join(', ')}`,
        { level: 'warning', tags: { component: 'data-quality-alert' }, extra: { freshnessAlerts } },
      );
    }

    // Not a failure — a readiness signal. The market predicate currently keeps
    // rows whose country is unknown, so this is what says when the reference
    // can safely be tightened to confirmed-Slovak-only. Reported at info while
    // it is merely incomplete; error only when a fifth of a source has no
    // market at all, which would mean the country parser stopped writing.
    const countryAlerts = pickCountryCoverageAlerts(report);
    const countryErrors = countryAlerts.filter((a) => a.level === 'error');
    if (countryErrors.length > 0) {
      Sentry.captureMessage(
        `Krajina sa neurčuje: ${countryErrors.map((a) => `${a.source} (${a.reason})`).join('; ')}`,
        { level: 'error', tags: { component: 'data-quality-alert' }, extra: { countryAlerts } },
      );
    } else if (countryAlerts.length > 0) {
      Sentry.captureMessage(
        `Pokrytie krajiny: ${countryAlerts.map((a) => a.source).join(', ')}`,
        { level: 'info', tags: { component: 'data-quality-alert' }, extra: { countryAlerts } },
      );
    }

    const alerts = pickDriftAlerts(report);
    const drift = alerts.filter((a) => a.health === 'drift');

    if (drift.length > 0) {
      Sentry.captureMessage(
        `Data-quality drift: ${drift.map((d) => `${d.source} (${d.reason})`).join('; ')}`,
        { level: 'warning', tags: { component: 'data-quality-alert' }, extra: { alerts } },
      );
    } else if (alerts.length > 0) {
      // Degraded-but-not-drift: keep it at info so it's visible without paging.
      Sentry.captureMessage(
        `Data-quality warn: ${alerts.map((a) => a.source).join(', ')}`,
        { level: 'info', tags: { component: 'data-quality-alert' }, extra: { alerts } },
      );
    }

    return NextResponse.json({
      runAt: new Date(report.generatedAt).toISOString(),
      driftCount: drift.length,
      freshness: report.freshness,
      freshnessAlerts,
      countryAlerts,
      warnCount: alerts.length - drift.length,
      alerts,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'data-quality-alert' } });
    return NextResponse.json(
      { error: 'alert_failed', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

// Also support POST for manual/scripted invocation.
export const POST = GET;

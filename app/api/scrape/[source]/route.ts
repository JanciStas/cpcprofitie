import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAdminUser } from '@/lib/auth/admin';
import { getCurrentUser } from '@/lib/auth/server';
import { isSameOrigin } from '@/lib/auth/csrf';
import {
  ALL_SOURCES,
  getSource,
  openScrapeRun,
  closeScrapeRun,
  runScrape,
  upsertListings,
  type Source,
} from '@/lib/scraping';

export const runtime = 'nodejs';
export const maxDuration = 300;

const BodySchema = z.object({
  pages: z.coerce.number().int().min(1).max(20).default(1),
});

type Ctx = { params: Promise<{ source: string }> };

export async function POST(request: Request, ctx: Ctx) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const user = await getCurrentUser();
  if (!user?.email) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isAdminUser(user)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { source: sourceParam } = await ctx.params;
  if (!ALL_SOURCES.includes(sourceParam as Source)) {
    return NextResponse.json(
      { error: 'unknown_source', allowed: ALL_SOURCES },
      { status: 404 },
    );
  }
  const source = getSource(sourceParam as Source);

  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    // empty body is fine — we use defaults
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const runId = await openScrapeRun(source.id, { startPage: 1, endPage: parsed.data.pages });
    const result = await runScrape(source, { pages: parsed.data.pages });
    const counts = await upsertListings(result.listings);
    await closeScrapeRun(runId, source.id, result, counts, {
      startPage: 1,
      endPage: result.lastPage,
      pagesOk: result.outcomes.filter((o) => o.kind === 'ok').length,
      pagesEmpty: result.outcomes.filter((o) => o.kind === 'empty').length,
      pagesNotFound: result.outcomes.filter((o) => o.kind === 'notFound').length,
      pagesError: result.outcomes.filter((o) => o.kind === 'error').length,
      stoppedReason: result.stoppedReason,
    });

    const status =
      result.errors.length === 0
        ? 200
        : result.listings.length > 0
          ? 207 // partial success
          : 502;

    if (result.errors.length > 0) {
      console.error('scrape_partial_or_failed', {
        source: source.id,
        errors: result.errors,
        listingsFound: result.listings.length,
      });
    }

    return NextResponse.json(
      {
        source: source.id,
        pagesVisited: result.pagesVisited,
        listingsFound: result.listings.length,
        counts,
        errors: result.errors,
        sample: result.listings.slice(0, 3),
      },
      { status },
    );
  } catch (e) {
    console.error('scrape_unexpected_failure', {
      source: source.id,
      error: e instanceof Error ? e.message : e,
    });
    return NextResponse.json({ error: 'scrape_unavailable' }, { status: 500 });
  }
}

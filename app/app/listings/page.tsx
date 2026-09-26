import { ListingsFilterBar, type InitialFilters } from '@/components/app/listings/filter-bar';
import { ListingsTable } from '@/components/app/listings/listings-table';
import { Pagination } from '@/components/app/listings/pagination';
import {
  getListings,
  getListingsStats,
  getRegionGroups,
  type ListingFilters,
  type ListingsSort,
} from '@/lib/db/queries/listings';
import type { RawFuel, Source } from '@/lib/scraping/types';

const KNOWN_SOURCES: Source[] = ['autobazar.sk', 'autobazar.eu', 'bazos.sk'];
const KNOWN_FUELS: RawFuel[] = [
  'gasoline',
  'diesel',
  'hybrid',
  'phev',
  'electric',
  'lpg',
  'cng',
  'other',
];

function formatNumber(n: number): string {
  return n.toLocaleString('sk-SK').replace(/,/g, ' ');
}

// Avoid PPR caching — listings table needs fresh DB reads.
export const dynamic = 'force-dynamic';

const PER_PAGE = 50;
const VALID_SORTS: ListingsSort[] = ['newest', 'oldest', 'price-asc', 'price-desc'];

function parseSort(v: string | undefined): ListingsSort {
  if (v && (VALID_SORTS as string[]).includes(v)) return v as ListingsSort;
  return 'newest';
}

function pickStr(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function parseCsv<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): T[] {
  if (!raw) return [];
  const set = new Set<string>(allowed);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && set.has(s)) as T[];
}

function parseInt0(raw: string | undefined, lo: number, hi: number): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const r = Math.floor(n);
  if (r < lo || r > hi) return undefined;
  return r;
}

export default async function ListingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const [stats, regionGroups] = await Promise.all([getListingsStats(), getRegionGroups()]);
  const regionNames = regionGroups.map((g) => g.name);

  const pageRaw = typeof sp.page === 'string' ? Number(sp.page) : 1;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const q = pickStr(sp.q);
  const sourceRaw = pickStr(sp.source);
  // Back-compat: ?source=autobazar.sk (single value) still works; CSV is new.
  const sources = sourceRaw ? parseCsv(sourceRaw, KNOWN_SOURCES) : [];
  const fuel = parseCsv(pickStr(sp.fuel), KNOWN_FUELS);
  const regionsCsv = pickStr(sp.regions);
  const selectedRegions = regionsCsv
    ? regionsCsv
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && regionNames.includes(s))
    : [];

  const minPrice = parseInt0(pickStr(sp.minPrice), 0, 10_000_000);
  const maxPrice = parseInt0(pickStr(sp.maxPrice), 0, 10_000_000);
  const minYear = parseInt0(pickStr(sp.minYear), 1900, 2100);
  const maxYear = parseInt0(pickStr(sp.maxYear), 1900, 2100);
  const minKm = parseInt0(pickStr(sp.minKm), 0, 10_000_000);
  const maxKm = parseInt0(pickStr(sp.maxKm), 0, 10_000_000);
  const hasPhoto = pickStr(sp.hasPhoto) === '1';
  const featuredOnly = pickStr(sp.featuredOnly) === '1';
  const sort = parseSort(pickStr(sp.sort));

  const filters: ListingFilters = {
    q,
    source: sources.length > 0 ? sources : undefined,
    fuel: fuel.length > 0 ? fuel : undefined,
    regions: selectedRegions.length > 0 ? selectedRegions : undefined,
    minPrice,
    maxPrice,
    minYear,
    maxYear,
    minKm,
    maxKm,
    hasPhoto: hasPhoto ? true : undefined,
    featuredOnly: featuredOnly ? true : undefined,
  };

  const { rows, total } = await getListings({
    page,
    perPage: PER_PAGE,
    filters,
    sort,
  });

  const initialFilters: InitialFilters = {
    q,
    sources,
    fuel,
    regions: selectedRegions,
    minPrice,
    maxPrice,
    minYear,
    maxYear,
    minKm,
    maxKm,
    hasPhoto,
    featuredOnly,
    sort,
  };

  return (
    <div className="container mx-auto px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Inzeráty</h1>
          <p className="text-muted-foreground mt-1 text-sm tabular-nums">
            {formatNumber(stats.totalListings)} inzerátov ·{' '}
            {formatNumber(stats.totalPhotos)} fotiek · {stats.bySource.length} zdroje
          </p>
          <p className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {stats.bySource.map((s, i) => {
              const dot = ['bg-emerald-500', 'bg-sky-500', 'bg-amber-500'][i] ?? 'bg-muted';
              return (
                <span key={s.source} className="inline-flex items-center gap-1.5">
                  <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
                  <span>{s.source}</span>
                  <span className="text-foreground tabular-nums font-medium">
                    {formatNumber(s.count)}
                  </span>
                </span>
              );
            })}
          </p>
        </div>
        <span className="border-border/60 bg-card/40 text-muted-foreground rounded-full border px-3 py-1 text-xs">
          Nájdených{' '}
          <span className="text-foreground font-semibold tabular-nums">{formatNumber(total)}</span>{' '}
          áut
        </span>
      </div>

      <div className="mb-4">
        <ListingsFilterBar
          sources={stats.bySource}
          regions={regionNames}
          initialFilters={initialFilters}
        />
      </div>
      <div className="space-y-4">
        <ListingsTable rows={rows} />
        <Pagination page={page} perPage={PER_PAGE} total={total} searchParams={sp} />
      </div>
    </div>
  );
}

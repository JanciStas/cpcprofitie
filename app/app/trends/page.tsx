import { TrendsTable } from '@/components/app/trends/trends-table';
import { getTrendingModels, type TrendsSort } from '@/lib/db/queries/trends';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Trendy modelov · CPCProfit' };

// 'movement' ranked models by sales we did not observe, so it ordered by a
// column that is now almost entirely zero. A sort with nothing to sort by is
// not degraded, it is broken — better absent until the sales are real.
const VALID_SORTS: TrendsSort[] = ['demand', 'price-drop', 'discounting'];

function parseSort(v: string | undefined): TrendsSort {
  if (v && (VALID_SORTS as string[]).includes(v)) return v as TrendsSort;
  return 'demand';
}

const SORT_LABELS: Record<TrendsSort, string> = {
  demand: 'Podľa dopytu',
  'price-drop': 'Najväčší pokles ceny',
  // Ranks on the RATE of cutting, not the count: the biggest model would
  // otherwise top the list purely for being biggest.
  discounting: 'Najviac zlacňujú',
};

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const sort = parseSort(typeof sp.sort === 'string' ? sp.sort : undefined);
  const rows = await getTrendingModels({ limit: 20, sort });

  return (
    <div className="container mx-auto px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Trendy modelov</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Týždenný prehľad dopytu, predaja a cien. Klik na model otvorí drill-down s
          rozdelením podľa regiónu a veku auta.
        </p>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {VALID_SORTS.map((s) => (
          <a
            key={s}
            href={`/app/trends?sort=${s}`}
            className={
              s === sort
                ? 'bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-xs font-medium'
                : 'border-border/60 hover:bg-muted rounded-md border px-3 py-1.5 text-xs font-medium'
            }
          >
            {SORT_LABELS[s]}
          </a>
        ))}
      </div>
      <TrendsTable rows={rows} />
    </div>
  );
}

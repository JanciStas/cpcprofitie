import { notFound } from 'next/navigation';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { formatNumber } from '@/components/app/kpi-card';
import { isAdminUser } from '@/lib/auth/admin';
import { getCurrentUser } from '@/lib/auth/server';
import {
  getRecentScrapeRuns,
  summarizeRuns,
  type ScrapeRunRow,
} from '@/lib/db/queries/scrape-runs';

export const metadata = { title: 'Admin · Scrape behy' };
export const dynamic = 'force-dynamic';

type Status = ScrapeRunRow['status'];

export default async function ScrapeRunsAdminPage() {
  const user = await getCurrentUser();
  if (!isAdminUser(user)) {
    notFound();
  }

  const runs = await getRecentScrapeRuns(30);
  const { succeeded24h: succeeded, failed24h: failed, totalAdded } = summarizeRuns(runs);

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
          Admin
        </p>
        <h1 className="text-3xl font-bold tracking-tight">Scrape behy</h1>
        <p className="text-muted-foreground text-sm">
          Posledných {runs.length} behov zo všetkých zdrojov.
        </p>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Úspešných (24h)" value={String(succeeded)} tone="positive" />
        <Stat label="Zlyhaných (24h)" value={String(failed)} tone={failed > 0 ? 'negative' : 'neutral'} />
        <Stat label="Pridaných listingov" value={formatNumber(totalAdded)} />
      </div>

      {runs.length === 0 ? (
        <div className="border-border/40 bg-card/30 mt-10 rounded-xl border p-10 text-center">
          <p className="text-muted-foreground text-sm">
            Zatiaľ žiadne behy — tabuľka sa naplní po najbližšom cron behu.
          </p>
        </div>
      ) : (
        <div className="border-border/40 mt-10 overflow-hidden rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-muted-foreground text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left font-medium">ID</th>
                <th className="px-4 py-3 text-left font-medium">Zdroj</th>
                <th className="px-4 py-3 text-left font-medium">Stav</th>
                <th className="px-4 py-3 text-left font-medium">Začiatok</th>
                <th className="px-4 py-3 text-right font-medium">Trvanie</th>
                <th className="px-4 py-3 text-right font-medium">+ Listingy</th>
                <th className="px-4 py-3 text-right font-medium">↻ Aktualizácie</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const durationMs = r.finishedAt
                  ? r.finishedAt.getTime() - r.startedAt.getTime()
                  : null;
                return (
                  <tr key={r.id} className="border-border/40 border-t">
                    <td className="text-muted-foreground px-4 py-3 font-mono text-xs">#{r.id}</td>
                    <td className="px-4 py-3 font-medium">{r.source}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={r.status} />
                      {r.errorMessage && (
                        <p className="text-destructive mt-1 text-xs">{r.errorMessage}</p>
                      )}
                    </td>
                    <td className="text-muted-foreground px-4 py-3 text-xs">
                      {r.startedAt.toLocaleString('sk-SK', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {durationMs != null ? `${(durationMs / 1000).toFixed(1)} s` : '—'}
                    </td>
                    <td className="text-chart-3 px-4 py-3 text-right font-medium tabular-nums">
                      {r.listingsAdded > 0 ? `+${formatNumber(r.listingsAdded)}` : '—'}
                    </td>
                    <td className="text-muted-foreground px-4 py-3 text-right tabular-nums">
                      {r.listingsUpdated > 0 ? formatNumber(r.listingsUpdated) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  if (status === 'succeeded') {
    return (
      <span className="bg-chart-3/15 text-chart-3 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium">
        <CheckCircle2 className="size-3" />
        OK
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="bg-destructive/15 text-destructive inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium">
        <XCircle className="size-3" />
        Zlyhal
      </span>
    );
  }
  return (
    <span className="bg-primary/15 text-primary inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium">
      <Clock className="size-3 animate-pulse" />
      {status === 'queued' ? 'Čaká' : 'Beží'}
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative' | 'neutral';
}) {
  const valueClass =
    tone === 'positive'
      ? 'text-chart-3'
      : tone === 'negative'
        ? 'text-destructive'
        : 'text-foreground';
  return (
    <div className="border-border/40 bg-card/40 rounded-xl border p-5">
      <p className="text-muted-foreground text-xs font-medium uppercase tracking-wider">{label}</p>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  );
}

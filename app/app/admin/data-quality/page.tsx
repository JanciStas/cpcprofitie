import { notFound } from 'next/navigation';
import { isAdminUser } from '@/lib/auth/admin';
import { getCurrentUser } from '@/lib/auth/server';
import { getDataQualityReport } from '@/lib/db/queries/data-quality';

export const metadata = { title: 'Admin · Kvalita dát' };
export const dynamic = 'force-dynamic';

// Green if the metric is healthy, amber if worth attention, red if bad.
// `invert` flips the direction for "coverage" metrics where higher is better.
function tone(value: number, warn: number, bad: number, invert = false): string {
  const v = invert ? 100 - value : value;
  const w = invert ? 100 - warn : warn;
  const b = invert ? 100 - bad : bad;
  if (v >= b) return 'text-destructive';
  if (v >= w) return 'text-amber-500';
  return 'text-chart-3';
}

export default async function DataQualityAdminPage() {
  const user = await getCurrentUser();
  if (!isAdminUser(user)) notFound();

  const report = await getDataQualityReport();

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">Admin</p>
        <h1 className="text-3xl font-bold tracking-tight">Kvalita dát</h1>
        <p className="text-muted-foreground text-sm">
          Completeness, outliery a pokrytie enrichmentu naprieč zdrojmi. Generované{' '}
          {new Date(report.generatedAt).toLocaleString('sk-SK')}.
        </p>
      </div>

      {/* DealScore health */}
      <div className="mt-8 grid gap-4 sm:grid-cols-4">
        <Stat label="Aktívne inzeráty" value={report.dealScore.activeCanonical.toLocaleString('sk-SK')} />
        <Stat label="Flip príležitosti" value={report.dealScore.flipRows.toLocaleString('sk-SK')} />
        <Stat label="S DealScore" value={report.dealScore.withDealScore.toLocaleString('sk-SK')} />
        <Stat label="Ø veľkosť kohortu" value={report.dealScore.avgCohortSize?.toString() ?? '—'} />
      </div>

      {/* Dedup health */}
      <h2 className="mt-10 text-base font-semibold tracking-tight">Deduplikácia repostov</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-4">
        <Stat
          label="Reposty (klony)"
          value={`${report.dedup.repostClones.toLocaleString('sk-SK')} · ${report.dedup.repostPct}%`}
        />
        <Stat label="VIN pokrytie" value={`${report.dedup.vinCoveragePct}%`} />
        <Stat
          label="Najväčší klaster"
          value={report.dedup.maxClusterSize.toString()}
        />
        <Stat
          label="Cross-source VIN"
          value={report.dedup.crossSourceVinClusters.toLocaleString('sk-SK')}
        />
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        Reposty (zmazané + znovu pridané inzeráty) sú napojené na kanonický záznam a vylúčené zo
        všetkých metrík. „Najväčší klaster“ je poistka proti nad-zlučovaniu — nezmyselne veľká
        hodnota by znamenala false-merge.
      </p>

      {/* Completeness */}
      <h2 className="mt-10 text-base font-semibold tracking-tight">Completeness (% chýbajúcich)</h2>
      <div className="border-border/40 mt-3 overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              <Th>Zdroj</Th>
              <Th right>Spolu</Th>
              <Th right>Aktívne</Th>
              <Th right>Cena</Th>
              <Th right>Rok</Th>
              <Th right>Km</Th>
              <Th right>Palivo</Th>
              <Th right>Prevod.</Th>
              <Th right>Región</Th>
              <Th right>Model</Th>
              <Th right>Kohort-ready</Th>
              <Th right>Outlier ceny/km</Th>
              <Th>Stav</Th>
            </tr>
          </thead>
          <tbody>
            {report.completeness.length === 0 ? (
              <tr>
                <td colSpan={13} className="text-muted-foreground px-4 py-8 text-center">
                  Zatiaľ žiadne dáta.
                </td>
              </tr>
            ) : (
              report.completeness.map((r) => (
                <tr key={r.source} className="border-border/40 border-t">
                  <td className="px-4 py-3 font-medium">{r.source}</td>
                  <Td>{r.total.toLocaleString('sk-SK')}</Td>
                  <Td>{r.active.toLocaleString('sk-SK')}</Td>
                  <Td className={tone(r.nullPricePct, 30, 60)}>{r.nullPricePct}%</Td>
                  <Td className={tone(r.nullYearPct, 10, 30)}>{r.nullYearPct}%</Td>
                  <Td className={tone(r.nullMileagePct, 10, 30)}>{r.nullMileagePct}%</Td>
                  <Td className={tone(r.nullFuelPct, 20, 50)}>{r.nullFuelPct}%</Td>
                  <Td className={tone(r.nullTransmissionPct, 30, 60)}>{r.nullTransmissionPct}%</Td>
                  <Td className={tone(r.nullRegionPct, 20, 50)}>{r.nullRegionPct}%</Td>
                  <Td className={tone(r.nullModelPct, 15, 40)}>{r.nullModelPct}%</Td>
                  <Td className={tone(r.cohortReadyPct, 60, 40, true)}>{r.cohortReadyPct}%</Td>
                  <Td className={r.outlierPrice + r.outlierMileage > 0 ? 'text-amber-500' : ''}>
                    {r.outlierPrice} / {r.outlierMileage}
                  </Td>
                  <td className="px-4 py-3">
                    <HealthBadge health={r.health} reason={r.healthReason} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Enrichment coverage */}
      <h2 className="mt-10 text-base font-semibold tracking-tight">Pokrytie enrichmentu (% aktívnych)</h2>
      <div className="border-border/40 mt-3 overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              <Th>Zdroj</Th>
              <Th right>Aktívne</Th>
              <Th right>Detail</Th>
              <Th right>Typ predajcu</Th>
              <Th right>VIN</Th>
              <Th right>Výkon</Th>
            </tr>
          </thead>
          <tbody>
            {report.enrichment.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-muted-foreground px-4 py-8 text-center">
                  Zatiaľ žiadne dáta.
                </td>
              </tr>
            ) : (
              report.enrichment.map((r) => (
                <tr key={r.source} className="border-border/40 border-t">
                  <td className="px-4 py-3 font-medium">{r.source}</td>
                  <Td>{r.active.toLocaleString('sk-SK')}</Td>
                  <Td className={tone(r.enrichedPct, 60, 30, true)}>{r.enrichedPct}%</Td>
                  <Td className={tone(r.sellerTypePct, 60, 30, true)}>{r.sellerTypePct}%</Td>
                  <Td className={tone(r.vinPct, 40, 15, true)}>{r.vinPct}%</Td>
                  <Td className={tone(r.powerPct, 40, 15, true)}>{r.powerPct}%</Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HealthBadge({
  health,
  reason,
}: {
  health: 'ok' | 'warn' | 'drift';
  reason: string | null;
}) {
  const cfg = {
    ok: { label: '🟢 OK', cls: 'bg-chart-3/15 text-chart-3' },
    warn: { label: '🟡 Pozor', cls: 'bg-amber-500/15 text-amber-500' },
    drift: { label: '🔴 Drift?', cls: 'bg-destructive/15 text-destructive' },
  }[health];
  return (
    <span
      title={reason ?? undefined}
      className={`inline-flex whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-4 py-3 font-medium ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 text-right tabular-nums ${className}`}>{children}</td>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border/40 bg-card/40 rounded-xl border p-5">
      <p className="text-muted-foreground text-xs font-medium uppercase tracking-wider">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

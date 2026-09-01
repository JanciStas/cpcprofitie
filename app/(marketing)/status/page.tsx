import { getPublicDataHealth, type PublicDataHealth } from '@/lib/db/queries/data-quality';

export const metadata = {
  title: 'Stav dát · CPCProfit',
  description: 'Verejný prehľad kvality scrapovaných dát naprieč zdrojmi — bez prihlásenia.',
};

// The page always renders; the heavy aggregation behind getPublicDataHealth is
// cached (unstable_cache, 10 min) so public traffic can't hammer the DB.
export const dynamic = 'force-dynamic';

type Overall = PublicDataHealth['overall'];

const OVERALL_CFG: Record<Overall, { label: string; cls: string; note: string }> = {
  ok: {
    label: '🟢 Dáta v poriadku',
    cls: 'bg-chart-3/10 text-chart-3 border-chart-3/30',
    note: 'Všetky zdroje majú zdravé pokrytie kľúčových polí.',
  },
  warn: {
    label: '🟡 Zvýšená chýbovosť',
    cls: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
    note: 'Niektorý zdroj má zvýšenú chýbovosť kľúčových polí. Sledujeme to.',
  },
  drift: {
    label: '🔴 Možný drift',
    cls: 'bg-destructive/10 text-destructive border-destructive/30',
    note: 'Niektorý zdroj má výpadok pokrytia — pravdepodobne zmena na stránke zdroja.',
  },
  unknown: {
    label: '⚫ Stav nedostupný',
    cls: 'bg-muted text-muted-foreground border-border/50',
    note: 'Report sa práve nepodarilo vypočítať. Skús obnoviť o chvíľu.',
  },
};

// Green / amber / red by threshold. `invert` for coverage metrics (higher = better).
function tone(value: number, warn: number, bad: number, invert = false): string {
  const v = invert ? 100 - value : value;
  const w = invert ? 100 - warn : warn;
  const b = invert ? 100 - bad : bad;
  if (v >= b) return 'text-destructive';
  if (v >= w) return 'text-amber-500';
  return 'text-chart-3';
}

const HEALTH_BADGE: Record<'ok' | 'warn' | 'drift', { label: string; cls: string }> = {
  ok: { label: '🟢 OK', cls: 'bg-chart-3/15 text-chart-3' },
  warn: { label: '🟡 Pozor', cls: 'bg-amber-500/15 text-amber-500' },
  drift: { label: '🔴 Drift?', cls: 'bg-destructive/15 text-destructive' },
};

function Metric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={`text-lg font-semibold tabular-nums ${className ?? ''}`}>{value}</span>
    </div>
  );
}

function SourceCard({ s }: { s: PublicDataHealth['sources'][number] }) {
  const badge = HEALTH_BADGE[s.health];
  return (
    <div className="border-border/40 bg-card rounded-xl border p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold tracking-tight">{s.source}</h3>
        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.label}</span>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {s.active.toLocaleString('sk-SK')} aktívnych inzerátov
      </p>
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Metric label="Chýba cena" value={`${s.nullPricePct}%`} className={tone(s.nullPricePct, 30, 60)} />
        <Metric label="Chýba model" value={`${s.nullModelPct}%`} className={tone(s.nullModelPct, 15, 40)} />
        <Metric
          label="Pripravené"
          value={`${s.cohortReadyPct}%`}
          className={tone(s.cohortReadyPct, 60, 40, true)}
        />
      </div>
      {/* Both numbers were computed all along and neither reached this page, so
          a stalled enrichment or a source that had stopped answering was
          invisible here. The backlog once stood at 16 318 while every source
          showed as healthy. */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Metric
          label="Stiahnuté detaily"
          value={`${s.enrichedPct}%`}
          className={tone(s.enrichedPct, 90, 70, true)}
        />
        <Metric
          label="Ceny v SLA"
          value={`${s.freshWithinSlaPct}%`}
          className={tone(s.freshWithinSlaPct, 95, 80, true)}
        />
      </div>
    </div>
  );
}

export default async function StatusPage() {
  const health = await getPublicDataHealth();
  const overall = OVERALL_CFG[health.overall];
  // How old the numbers below actually are.
  //
  // This page served a report generated on 26 August until 1 September without
  // saying so -- six days, while claiming autobazar.eu prices were 59.7% inside
  // SLA when they were 6.1%. The cached report is refreshed by the daily
  // watchdog now, but a page whose whole job is reporting data quality must not
  // be able to go quietly stale again: if the timestamp is old, say it loudly
  // rather than presenting the figures as current.
  const ageHours = health.overall === 'unknown' ? null : health.ageHours;
  const stale = ageHours != null && ageHours > 24;
  const updated =
    health.overall === 'unknown'
      ? null
      : new Date(health.generatedAt).toLocaleString('sk-SK', {
          dateStyle: 'medium',
          timeStyle: 'short',
        });

  return (
    <div className="container mx-auto max-w-4xl px-4 py-12 sm:px-6 lg:py-16">
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">Verejný prehľad</p>
        <h1 className="text-3xl font-bold tracking-tight">Stav dát</h1>
        <p className="text-muted-foreground text-sm">
          Živý prehľad kvality scrapovaných dát, na ktorých stojí DealScore. Prepočítava sa
          priebežne a najmenej raz denne.
        </p>
      </div>

      {stale && (
        <div className="mt-8 rounded-xl border border-amber-500/40 bg-amber-500/10 px-5 py-4">
          <p className="text-lg font-semibold">Čísla nižšie sú zastarané</p>
          <p className="mt-0.5 text-sm opacity-90">
            Posledný prepočet prebehol pred {Math.floor(ageHours! / 24)} dňami. Skutočný stav sa od
            zobrazeného môže výrazne líšiť.
          </p>
        </div>
      )}

      <div className={`mt-8 rounded-xl border px-5 py-4 ${overall.cls}`}>
        <p className="text-lg font-semibold">{overall.label}</p>
        <p className="mt-0.5 text-sm opacity-90">{overall.note}</p>
      </div>

      {health.sources.length > 0 ? (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {health.sources.map((s) => (
              <SourceCard key={s.source} s={s} />
            ))}
          </div>

          <div className="text-muted-foreground mt-6 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span>
              Spolu aktívnych:{' '}
              <span className="text-foreground font-medium tabular-nums">
                {health.totalActive.toLocaleString('sk-SK')}
              </span>
            </span>
            <span>
              Reposty (duplicity):{' '}
              <span className="text-foreground font-medium tabular-nums">{health.repostPct}%</span>
            </span>
            {updated && <span>Aktualizované: {updated}</span>}
          </div>

          <div className="text-muted-foreground mt-8 space-y-1 text-xs leading-relaxed">
            <p>
              <strong className="text-foreground">Chýba cena / model</strong> — podiel aktívnych
              inzerátov bez tohto poľa. Nižšie je lepšie.
            </p>
            <p>
              <strong className="text-foreground">Pripravené</strong> — podiel inzerátov s
              kompletnými poľami pre výpočet DealScore. Vyššie je lepšie.
            </p>
            <p>
              <strong className="text-foreground">Reposty</strong> — inzeráty zmazané a znovu pridané,
              napojené na pôvodný záznam a vylúčené zo všetkých metrík.
            </p>
          </div>
        </>
      ) : (
        <p className="text-muted-foreground mt-6 text-sm">
          Momentálne tu nie sú žiadne dáta na zobrazenie.
        </p>
      )}
    </div>
  );
}

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="from-primary/20 absolute inset-x-0 -top-40 -z-10 h-[40rem] bg-gradient-to-b to-transparent blur-3xl"
      />
      <div
        aria-hidden
        className="bg-chart-2/10 absolute -right-32 top-32 -z-10 size-96 rounded-full blur-3xl"
      />

      <div className="container mx-auto px-4 pb-24 pt-20 sm:px-6 lg:px-8 lg:pb-32 lg:pt-28">
        <div className="mx-auto max-w-3xl text-center">
          <Badge variant="secondary" className="mb-6">
            <span className="bg-chart-2 mr-2 size-1.5 animate-pulse rounded-full" />
            Verejná beta · pre slovenských dealerov
          </Badge>

          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Predávajte autá so{' '}
            <span className="from-primary to-chart-2 bg-gradient-to-r bg-clip-text text-transparent">
              dátami, nie odhadom
            </span>
            .
          </h1>

          <p className="text-muted-foreground mx-auto mt-6 max-w-2xl text-lg leading-relaxed sm:text-xl">
            CPCProfit kombinuje reálne ceny zo slovenského trhu, AI insights a inteligentné
            upozornenia. Všetko v jednej platforme pre profesionálnych predajcov.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" render={<Link href="/register" />}>
              Vyskúšať zadarmo
            </Button>
            <Button size="lg" variant="outline" render={<Link href="#features" />}>
              Pozrieť funkcie
            </Button>
          </div>

          <p className="text-muted-foreground mt-6 text-sm">
            Počas bety zadarmo · Bez platobnej karty
          </p>
        </div>

        <div className="relative mx-auto mt-20 max-w-5xl">
          <div className="from-primary/30 to-chart-2/30 absolute inset-0 -z-10 rounded-2xl bg-gradient-to-br blur-2xl" />
          <div className="border-border/60 bg-card/80 relative overflow-hidden rounded-2xl border shadow-2xl backdrop-blur">
            <div className="border-border/60 flex items-center gap-2 border-b px-4 py-3">
              <div className="flex gap-1.5">
                <span className="size-3 rounded-full bg-red-500/60" />
                <span className="size-3 rounded-full bg-yellow-500/60" />
                <span className="size-3 rounded-full bg-green-500/60" />
              </div>
              <span className="text-muted-foreground ml-2 font-mono text-xs">
                cpcprofit.sk/app/overview
              </span>
            </div>
            <div className="grid gap-4 p-6 sm:grid-cols-3">
              {[
                // Facts about the product, not invented market figures. This panel
                // used to show hardcoded KPIs ("€1 847 priemerná marža",
                // "+8.2 % MoM") dressed as a screenshot of the live dashboard.
                { label: 'Zdroje', value: '3 portály', delta: 'bazos · autobazar.sk · .eu', positive: true },
                { label: 'Aktualizácia cien', value: 'každé 2 h', delta: 'automaticky', positive: true },
                { label: 'Hodnotenie ponuky', value: 'DealScore', delta: 'voči mediánu trhu', positive: true },
              ].map((kpi) => (
                <div
                  key={kpi.label}
                  className="border-border/60 bg-background/50 rounded-lg border p-4"
                >
                  <p className="text-muted-foreground text-xs">{kpi.label}</p>
                  <p className="mt-1 text-2xl font-semibold tracking-tight">{kpi.value}</p>
                  <p
                    className={
                      kpi.positive ? 'text-chart-3 mt-1 text-xs' : 'text-destructive mt-1 text-xs'
                    }
                  >
                    {kpi.delta}
                  </p>
                </div>
              ))}
            </div>
            <div className="grid gap-px bg-border/60 sm:grid-cols-7">
              {[18, 32, 28, 45, 52, 41, 64].map((h, i) => (
                <div key={i} className="bg-card flex h-32 items-end p-3">
                  <div
                    className="from-primary/80 to-chart-2/60 w-full rounded-sm bg-gradient-to-t"
                    style={{ height: `${h}%` }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

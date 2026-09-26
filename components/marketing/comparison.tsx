import { Check, X } from 'lucide-react';

const rows = [
  {
    without: 'Hádanie cien podľa "feelu"',
    with: 'Reálne agregované dáta z tisícov inzerátov',
  },
  {
    without: 'Hodiny scrollovania bazárov',
    with: '30 sekundový prehľad trhu po regiónoch',
  },
  {
    without: 'Univerzálne kopírované inzeráty',
    with: 'AI generovaný text prispôsobený modelu a tónu',
  },
  {
    without: 'Strata príležitostí, kým ich konkurencia kúpi',
    with: 'E-mail alert hneď ako sa objaví váš model',
  },
  {
    without: 'Slepé tipovanie marže',
    with: 'Štatistická istota s p25/p75 distribúciou',
  },
];

export function Comparison() {
  return (
    <section className="border-border/40 border-y">
      <div className="container mx-auto px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Rozdiel, ktorý cítite na výplate
          </h2>
          <p className="text-muted-foreground mt-4 text-lg">
            Namiesto hodín prezerania troch portálov máte trhovú cenu, porovnanie a hodnotenie
            ponuky na jednom mieste.
          </p>
        </div>

        <div className="mx-auto mt-14 max-w-4xl overflow-hidden rounded-xl border">
          <div className="grid grid-cols-2">
            <div className="bg-muted/30 border-border/60 border-r p-4 text-center">
              <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                Bez CPCProfit
              </p>
            </div>
            <div className="bg-primary/5 p-4 text-center">
              <p className="text-primary text-xs font-semibold uppercase tracking-wider">
                S CPCProfit
              </p>
            </div>
          </div>
          {rows.map((row, i) => (
            <div
              key={i}
              className="border-border/40 grid grid-cols-2 border-t [&>div]:px-6 [&>div]:py-5"
            >
              <div className="border-border/60 flex items-start gap-3 border-r">
                <X className="text-muted-foreground mt-0.5 size-5 shrink-0" />
                <span className="text-muted-foreground text-sm">{row.without}</span>
              </div>
              <div className="bg-primary/[0.02] flex items-start gap-3">
                <Check className="text-primary mt-0.5 size-5 shrink-0" />
                <span className="text-foreground text-sm font-medium">{row.with}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

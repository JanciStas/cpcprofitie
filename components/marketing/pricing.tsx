import Link from 'next/link';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

// Free beta: nobody can pay yet (Stripe is not configured in production, and
// the checkout path never persisted a subscription), so only the beta plan has
// a live button. The paid plans list only what actually exists in the product;
// they used to advertise an API, push alerts, "anomálie" and a 4-hour support
// SLA, none of which was built.
const plans = [
  {
    name: 'Beta',
    price: '€0',
    period: 'počas bety',
    description: 'Plný prístup k trhovým dátam, kým ladíme produkt.',
    cta: 'Začať zadarmo',
    href: '/register' as string | null,
    highlighted: true,
    features: [
      'Inzeráty z 3 portálov na jednom mieste',
      'DealScore a príležitosti pod trhovou cenou',
      'Trendy cien a zlacnení po modeloch',
      '3 AI inzeráty mesačne',
      '1 sledovaný model s e-mail upozornením',
      'Moja garáž (do 3 áut)',
    ],
  },
  {
    name: 'Plus',
    price: '€19',
    period: 'mesačne',
    description: 'Pre solo dealerov a malé bazáre.',
    cta: 'Pripravujeme',
    href: null,
    highlighted: false,
    features: [
      'Všetko z bety',
      '50 AI inzerátov mesačne',
      '5 sledovaných modelov',
      'Moja garáž (do 20 áut)',
    ],
  },
  {
    name: 'Premium',
    price: '€49',
    period: 'mesačne',
    description: 'Pre tímy a väčšie autobazáre.',
    cta: 'Pripravujeme',
    href: null,
    highlighted: false,
    features: ['Všetko z Plus', 'Neobmedzené AI inzeráty', 'Neobmedzené sledované modely'],
  },
];

export function Pricing() {
  return (
    <section id="pricing" className="container mx-auto px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Počas bety zadarmo
        </h2>
        <p className="text-muted-foreground mt-4 text-lg">
          Platené plány spustíme po bete. Kto sa zaregistruje teraz, dozvie sa o tom ako prvý.
        </p>
      </div>

      <div className="mx-auto mt-14 grid max-w-5xl grid-cols-1 gap-6 md:grid-cols-3">
        {plans.map((plan) => (
          <div
            key={plan.name}
            className={
              plan.highlighted
                ? 'border-primary bg-card relative rounded-2xl border-2 p-8 shadow-lg'
                : 'border-border/40 bg-card/30 relative rounded-2xl border p-8'
            }
          >
            {plan.highlighted && (
              <Badge className="absolute -top-3 left-1/2 -translate-x-1/2">Dostupné teraz</Badge>
            )}
            <h3 className="text-lg font-semibold tracking-tight">{plan.name}</h3>
            <p className="text-muted-foreground mt-1 text-sm">{plan.description}</p>
            <div className="mt-6 flex items-baseline gap-1">
              <span className="text-4xl font-bold tracking-tight">{plan.price}</span>
              <span className="text-muted-foreground text-sm">/ {plan.period}</span>
            </div>
            {plan.href ? (
              <Button
                variant={plan.highlighted ? 'default' : 'outline'}
                className="mt-6 w-full"
                render={<Link href={plan.href} />}
              >
                {plan.cta}
              </Button>
            ) : (
              <Button variant="outline" className="mt-6 w-full" disabled>
                {plan.cta}
              </Button>
            )}
            <ul className="mt-8 space-y-3">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm">
                  <Check className="text-primary mt-0.5 size-4 shrink-0" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="text-muted-foreground mt-8 text-center text-sm">
        Ceny platených plánov sú orientačné a bez DPH.
      </p>
    </section>
  );
}

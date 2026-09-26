import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getCurrentUser } from '@/lib/auth/server';
import { effectivePlan, getUserSubscription } from '@/lib/billing/subscription';
import { getUsageSummary } from '@/lib/billing/usage';
import { PLANS } from '@/lib/billing/plans';
import { isStripeConfigured } from '@/lib/stripe/server';

export const metadata = { title: 'Predplatné' };

export default async function BillingPage() {
  const user = await getCurrentUser();
  const [sub, usage] = user
    ? await Promise.all([getUserSubscription(user.id), getUsageSummary(user.id)])
    : [null, { aiListingsThisMonth: 0, watchlistCount: 0, garageCount: 0 }];
  const planId = effectivePlan(sub);
  const plan = PLANS[planId];
  const stripeReady = isStripeConfigured();
  const hasCustomer = Boolean(sub?.stripeCustomerId);

  const quotas = [
    { label: 'AI inzeráty', used: usage.aiListingsThisMonth, limit: plan.quotas.aiListingsPerMonth },
    { label: 'Sledované modely', used: usage.watchlistCount, limit: plan.quotas.watchlistEntries },
    { label: 'Garáž', used: usage.garageCount, limit: plan.quotas.garageEntries },
  ];

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Váš plán</h1>
        <p className="text-muted-foreground text-sm">
          Počas bety je CPCProfit zadarmo. Platené plány spustíme neskôr a vopred vás upozorníme.
        </p>
      </div>

      <section className="border-border/40 bg-card/30 mt-8 rounded-xl border p-6">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-muted-foreground text-xs uppercase tracking-wider">Aktuálny plán</p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">{plan.name}</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {sub?.status ?? 'Beta — zadarmo'}
              {sub?.currentPeriodEnd
                ? ` · obnovenie ${new Date(sub.currentPeriodEnd).toLocaleDateString('sk-SK')}`
                : ''}
            </p>
          </div>
          <Button variant="outline" render={<Link href="/#pricing" />}>
            Pozrieť plány
          </Button>
        </header>

        <div className="mt-6 grid gap-3">
          {quotas.map((q) => {
            const isUnlimited = q.limit < 0;
            const pct = isUnlimited ? 8 : Math.min(100, (q.used / Math.max(1, q.limit)) * 100);
            return (
              <div key={q.label}>
                <div className="flex items-center justify-between text-sm">
                  <span>{q.label}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {isUnlimited ? `${q.used} / ∞` : `${q.used} / ${q.limit}`}
                  </span>
                </div>
                <div className="bg-muted/40 mt-1.5 h-1.5 overflow-hidden rounded-full">
                  <div className="bg-primary h-full transition-all" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Only for someone who has actually paid. During the free beta nobody
          has, and the old fallback button read "Čakáme na Stripe wiring" to users. */}
      {stripeReady && hasCustomer ? (
        <section className="border-border/40 bg-card/30 mt-6 rounded-xl border p-6">
          <h2 className="text-base font-semibold tracking-tight">Platby a faktúry</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Upravte spôsob platby, stiahnite faktúry alebo zrušte predplatné.
          </p>
          <form action="/api/stripe/portal" method="post" className="mt-4">
            <Button type="submit" variant="outline">
              <ExternalLink className="size-4" />
              Otvoriť portál
            </Button>
          </form>
        </section>
      ) : null}
    </div>
  );
}


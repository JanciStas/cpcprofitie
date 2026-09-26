import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SITE } from '@/lib/site';

export function CTABanner() {
  return (
    <section className="container mx-auto px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
      <div className="from-primary/20 via-card to-chart-2/20 border-border/60 relative mx-auto max-w-5xl overflow-hidden rounded-3xl border bg-gradient-to-br p-12 text-center sm:p-16">
        <div
          aria-hidden
          className="bg-primary/30 absolute -left-24 -top-24 size-72 rounded-full blur-3xl"
        />
        <div
          aria-hidden
          className="bg-chart-2/30 absolute -bottom-24 -right-24 size-72 rounded-full blur-3xl"
        />
        <h2 className="relative text-3xl font-bold tracking-tight sm:text-4xl">
          Začnite predávať s istotou.
        </h2>
        <p className="text-muted-foreground relative mx-auto mt-4 max-w-2xl text-lg">
          Počas bety zadarmo. Bez platobnej karty, bez záväzku. Dáta z bazos.sk, autobazar.sk a
          autobazar.eu na jednom mieste.
        </p>
        <div className="relative mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button size="lg" render={<Link href="/register" />}>
            Vyskúšať zadarmo
          </Button>
          <Button size="lg" variant="outline" render={<a href={`mailto:${SITE.contactEmail}`} />}>
            Napíšte nám
          </Button>
        </div>
      </div>
    </section>
  );
}

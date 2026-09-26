import Link from 'next/link';
import { SITE } from '@/lib/site';

// Only routes that exist. The footer used to link /changelog, /about,
// /partners and /legal/cookies, all 404s; a footer full of dead ends is the
// first thing a visitor checking whether a service is real will click.
const columns = [
  {
    title: 'Produkt',
    links: [
      { href: '/#features', label: 'Funkcie' },
      { href: '/#pricing', label: 'Cenník' },
      { href: '/#faq', label: 'FAQ' },
      { href: '/status', label: 'Stav dát' },
    ],
  },
  {
    title: 'Kontakt',
    links: [{ href: `mailto:${SITE.contactEmail}`, label: SITE.contactEmail }],
  },
  {
    title: 'Právne',
    links: [
      { href: '/legal/terms', label: 'Obchodné podmienky' },
      { href: '/legal/privacy-policy', label: 'Ochrana údajov' },
      { href: '/legal/cookies', label: 'Cookies' },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-border/40 border-t">
      <div className="container mx-auto px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <Link href="/" className="flex items-center gap-2">
              <span className="from-primary to-chart-2 flex size-8 items-center justify-center rounded-lg bg-gradient-to-br text-sm font-bold text-white">
                C
              </span>
              <span className="text-base font-semibold tracking-tight">CPCProfit</span>
            </Link>
            <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
              Dáta a AI pre profesionálnych obchodníkov s vozidlami.
            </p>
          </div>

          {columns.map((col) => (
            <div key={col.title}>
              <h3 className="text-sm font-semibold tracking-tight">{col.title}</h3>
              <ul className="mt-4 space-y-3">
                {col.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-muted-foreground hover:text-foreground text-sm transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-border/40 mt-12 flex flex-col items-start justify-between gap-4 border-t pt-8 sm:flex-row sm:items-center">
          <p className="text-muted-foreground text-xs">
            © {new Date().getFullYear()} CPCProfit. Všetky práva vyhradené.
          </p>
          <p className="text-muted-foreground text-xs">
            Vytvorené na Slovensku · Poháňané Vercel a Anthropic Claude
          </p>
        </div>
      </div>
    </footer>
  );
}

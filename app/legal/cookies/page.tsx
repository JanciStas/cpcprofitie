import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteHeader } from '@/components/marketing/site-header';
import { OperatorBlock } from '@/components/legal/operator-block';
import { SITE } from '@/lib/site';

export const metadata = {
  title: 'Cookies',
};

const LAST_UPDATED = '2026-09-26';

// Linked from the footer, the privacy policy and the cookie banner; it was a
// 404. Describes what the site actually sets: the Supabase auth session and
// the stored consent choice. Vercel Analytics is cookieless.
export default function CookiesPage() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <article className="container mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
          <header>
            <h1 className="text-4xl font-bold tracking-tight">Cookies</h1>
            <p className="text-muted-foreground mt-2 text-sm">
              Posledná aktualizácia: {LAST_UPDATED}
            </p>
          </header>

          <div className="mt-10 space-y-8 text-sm leading-relaxed">
            <Section title="Čo používame">
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  <strong>Prihlásenie</strong> — cookies začínajúce na <code>sb-</code>, ktoré
                  udržiavajú vaše prihlásenie. Bez nich sa nedá používať účet. Platnosť: po dobu
                  prihlásenia.
                </li>
                <li>
                  <strong>Vaša voľba v cookie lište</strong> — uložená v úložisku prehliadača
                  (localStorage), aby sa lišta nezobrazovala pri každej návšteve.
                </li>
              </ul>
            </Section>

            <Section title="Čo nepoužívame">
              <p>
                Nepoužívame reklamné ani sledovacie cookies tretích strán. Štatistiky
                návštevnosti (Vercel Analytics) cookies nepoužívajú a návštevníka neidentifikujú.
              </p>
            </Section>

            <Section title="Ako to zmeniť">
              <p>
                Cookies môžete kedykoľvek zmazať v nastaveniach prehliadača. Po zmazaní vás
                odhlásime a lišta sa zobrazí znova.
              </p>
            </Section>

            <Section title="Prevádzkovateľ">
              <OperatorBlock />
              <p>
                Otázky k súkromiu:{' '}
                <a href={`mailto:${SITE.privacyEmail}`} className="text-primary hover:underline">
                  {SITE.privacyEmail}
                </a>
              </p>
            </Section>
          </div>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-foreground text-xl font-semibold">{title}</h2>
      <div className="text-muted-foreground mt-3 space-y-3">{children}</div>
    </section>
  );
}

import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteHeader } from '@/components/marketing/site-header';
import { OperatorBlock } from '@/components/legal/operator-block';
import { SITE } from '@/lib/site';

export const metadata = {
  title: 'Ochrana osobných údajov',
};

const LAST_UPDATED = '2026-09-26';

export default function PrivacyPage() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <article className="container mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
          <header>
            <h1 className="text-4xl font-bold tracking-tight">Ochrana osobných údajov</h1>
            <p className="text-muted-foreground mt-2 text-sm">
              Posledná aktualizácia: {LAST_UPDATED}
            </p>
          </header>

          <div className="prose prose-invert mt-10 space-y-8 text-sm leading-relaxed">
            <Section title="1. Prevádzkovateľ">
              <OperatorBlock />
              <p>
                Otázky ohľadom súkromia:{' '}
                <a href={`mailto:${SITE.privacyEmail}`} className="text-primary hover:underline">
                  {SITE.privacyEmail}
                </a>
                .
              </p>
            </Section>

            <Section title="2. Aké údaje spracúvame">
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong>Účet:</strong> e-mail a heslo (uložené len v hašovanej podobe u
                  poskytovateľa autentifikácie).
                </li>
                <li>
                  <strong>Fakturácia:</strong> spracovávaná Stripe Payments Europe Ltd. — my
                  ukladáme iba ID zákazníka a stav predplatného.
                </li>
                <li>
                  <strong>Obchodné dáta Užívateľa:</strong> vozidlá v Garáži, sledované modely
                  (Watchlist), AI generované texty inzerátov.
                </li>
                <li>
                  <strong>Telemetria:</strong> anonymné štatistiky návštevnosti (Vercel
                  Analytics), ktoré nepoužívajú cookies a neidentifikujú návštevníka.
                </li>
                <li>
                  <strong>Chybové stopy:</strong> Sentry Error Tracking — bez osobných údajov.
                </li>
              </ul>
            </Section>

            <Section title="3. Verejné inzeráty z autobazárov">
              <p>
                Z verejne zverejnených inzerátov na bazos.sk, autobazar.sk a autobazar.eu
                spracúvame údaje o vozidle: značka, model, rok výroby, najazdené kilometre,
                palivo, prevodovka, cena, lokalita, fotografie (odkazom, neukladáme ich), VIN ak je
                zverejnený, a URL inzerátu. Ak portál zverejňuje názov predajcu (typicky
                autobazára), ukladáme aj ten. <strong>Telefónne čísla ani e-mailové adresy
                predajcov nezobrazujeme</strong> a údaje nepoužívame na kontaktovanie predajcov.
                Právnym základom je oprávnený záujem (čl. 6 ods. 1 f GDPR) na analýze trhu
                z verejne dostupných údajov.
              </p>
            </Section>

            <Section title="4. Právny základ a účel">
              <p>
                Spracúvame údaje na základe <strong>plnenia zmluvy</strong> (čl. 6 ods. 1 b
                GDPR — poskytovanie platformy), <strong>oprávneného záujmu</strong> (čl. 6 ods.
                1 f — bezpečnosť a prevencia podvodov) a v prípade marketingu na základe
                <strong> súhlasu</strong> (čl. 6 ods. 1 a).
              </p>
            </Section>

            <Section title="5. Doba uchovávania">
              <p>
                Údaje účtu uchovávame počas trvania zmluvy a 12 mesiacov po jej ukončení.
                Fakturačné údaje 10 rokov v zmysle účtovných predpisov. Anonymizované trhové
                dáta uchovávame neobmedzene pre historickú analýzu.
              </p>
            </Section>

            <Section title="6. Príjemcovia údajov">
              <ul className="list-disc space-y-1 pl-5">
                <li>Vercel Inc. (hosting)</li>
                <li>Supabase Inc. (databáza a autentifikácia)</li>
                <li>Resend (odosielanie e-mailov)</li>
                <li>Anthropic (generovanie AI inzerátov, cez Vercel AI Gateway)</li>
                <li>Functional Software Inc. — Sentry (zaznamenávanie chýb)</li>
                <li>Stripe Payments Europe Ltd. (platby — až po spustení platených plánov)</li>
              </ul>
            </Section>

            <Section title="7. Vaše práva">
              <p>
                Máte právo na prístup k údajom, ich opravu, vymazanie, obmedzenie spracúvania,
                prenos a podanie sťažnosti dozornému orgánu (Úrad na ochranu osobných údajov SR).
                Žiadosti smerujte na{' '}
                <a href={`mailto:${SITE.privacyEmail}`} className="text-primary hover:underline">
                  {SITE.privacyEmail}
                </a>{' '}
                — odpoveď do 30 dní.
              </p>
            </Section>

            <Section title="8. Cookies">
              <p>
                Používame len nevyhnutné cookies potrebné na prihlásenie. Podrobnosti sú na
                stránke{' '}
                <a href="/legal/cookies" className="text-primary hover:underline">
                  Cookies
                </a>
                .
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

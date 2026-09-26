import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteHeader } from '@/components/marketing/site-header';
import { OperatorBlock } from '@/components/legal/operator-block';
import { SITE } from '@/lib/site';

export const metadata = {
  title: 'Obchodné podmienky',
};

const LAST_UPDATED = '2026-09-26';

export default function TermsPage() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <article className="container mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
          <header>
            <h1 className="text-4xl font-bold tracking-tight">Obchodné podmienky</h1>
            <p className="text-muted-foreground mt-2 text-sm">
              Posledná aktualizácia: {LAST_UPDATED}
            </p>
          </header>

          <div className="prose prose-invert mt-10 space-y-8 text-sm leading-relaxed">
            <Section title="1. Všeobecné ustanovenia">
              <p>
                Tieto obchodné podmienky upravujú práva a povinnosti medzi prevádzkovateľom
                platformy CPCProfit (ďalej „Poskytovateľ“) a používateľom služby (ďalej
                „Užívateľ“).
              </p>
              <OperatorBlock />
              <p>
                Užívateľom môže byť fyzická osoba — podnikateľ alebo právnická osoba sídliaca v
                Európskej únii. Spotrebiteľ podľa zákona 250/2007 Z. z. o ochrane spotrebiteľa
                aktuálne nie je cieľovou skupinou platformy.
              </p>
            </Section>

            <Section title="2. Predmet zmluvy">
              <p>
                Poskytovateľ poskytuje SaaS platformu pre analýzu trhu vozidiel — agregované
                ceny verejne dostupných inzerátov, AI generovanie textov inzerátov, sledovanie
                modelov a porovnania. Služba je v štádiu bety: funkcie sa môžu meniť a
                dostupnosť nie je garantovaná.
              </p>
            </Section>

            <Section title="3. Cena, platba a fakturácia">
              <p>
                Počas bety je služba bezplatná. Platené plány Poskytovateľ zavedie až po
                ukončení bety a Užívateľa o tom vopred upozorní e-mailom. Bez výslovného
                objednania Užívateľom sa nikdy nič neúčtuje.
              </p>
            </Section>

            <Section title="4. Odstúpenie od zmluvy a refundácie">
              <p>
                Užívateľ môže službu kedykoľvek prestať používať a požiadať o zrušenie účtu na{' '}
                <a href={`mailto:${SITE.privacyEmail}`} className="text-primary hover:underline">
                  {SITE.privacyEmail}
                </a>
                .
              </p>
            </Section>

            <Section title="5. Prípustné použitie">
              <p>
                Užívateľ sa zaväzuje nepoužívať platformu na automatizované sťahovanie dát, na reverzné inžinierstvo modelov, ani na
                vytváranie konkurenčného produktu kopírovaním obsahu.
              </p>
            </Section>

            <Section title="6. Obmedzenie zodpovednosti">
              <p>
                Údaje o cenách sú agregované z verejných inzerátov a slúžia ako podklad pre
                rozhodovanie. Poskytovateľ neručí za presnosť každého jednotlivého záznamu ani
                za zisk plynúci z rozhodnutí Užívateľa. Počas bety sa služba poskytuje
                bezplatne a „tak, ako je“.
              </p>
            </Section>

            <Section title="7. Zmena podmienok">
              <p>
                Poskytovateľ môže tieto podmienky upraviť. Materiálna zmena je oznámená 30 dní
                vopred e-mailom. Ak Užívateľ so zmenou nesúhlasí, môže účet zrušiť.
              </p>
            </Section>

            <Section title="8. Kontakt">
              <p>
                Otázky a reklamácie:{' '}
                <a href={`mailto:${SITE.contactEmail}`} className="text-primary hover:underline">
                  {SITE.contactEmail}
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

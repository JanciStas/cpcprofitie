import { SITE } from '@/lib/site';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

// Every answer here has to be true of the product as it runs today. The
// previous list promised a REST API, a customer portal that could not be
// reached, German and Czech feeds, an AI fallback that is not wired, and said
// no seller data is stored while seller names are.
const items = [
  {
    q: 'Odkiaľ pochádzajú dáta o cenách?',
    a: 'Zo zverejnených inzerátov na bazos.sk, autobazar.sk a autobazar.eu. Zbierame údaje o vozidle — model, rok, nájazd, cenu, lokalitu — a názov predajcu, ak ho portál zverejňuje. Telefónne čísla predajcov nezobrazujeme.',
  },
  {
    q: 'Ako často sa dáta aktualizujú?',
    a: 'Nové inzeráty zbierame každé 2 hodiny, detaily a ceny sa dopĺňajú priebežne každú hodinu. Trhové mediány a trendy sa prepočítavajú raz denne v noci. Aktuálny stav vidíte na stránke Stav dát.',
  },
  {
    q: 'Koľko to stojí?',
    a: 'Počas bety nič. Platené plány spustíme až potom a včas vás o nich upozorníme — bez vášho súhlasu vám nikdy nič nestrhneme.',
  },
  {
    q: 'Funguje CPCProfit aj pre český trh?',
    a: 'Nie, zameriavame sa na Slovensko. České inzeráty z autobazar.eu z výpočtu trhových cien zámerne vylučujeme, aby neskresľovali slovenský medián.',
  },
  {
    q: 'Je platforma vhodná aj pre súkromníkov?',
    a: 'Pozrieť si trhovú cenu vie ktokoľvek, no produkt je navrhnutý pre profesionálnych predajcov, ktorí nakupujú a predávajú vozidlá pravidelne.',
  },
  {
    q: 'Aké AI modely sa používajú na generovanie inzerátov?',
    a: 'Anthropic Claude Haiku cez Vercel AI Gateway. Vaše vstupy sa nepoužívajú na trénovanie modelov.',
  },
  {
    q: 'Ako chránite moje údaje?',
    a: 'O vás spracúvame len to, čo treba na fungovanie účtu: e-mail a údaje, ktoré si sami uložíte (garáž, sledované modely). Podrobnosti nájdete v Ochrane údajov.',
  },
];

export function FAQ() {
  return (
    <section id="faq" className="border-border/40 border-t">
      <div className="container mx-auto px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <div className="mx-auto max-w-3xl">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Časté otázky</h2>
            <p className="text-muted-foreground mt-4 text-lg">
              Niečo, čo nie je v zozname? Napíšte nám na{' '}
              <a href={`mailto:${SITE.contactEmail}`} className="text-primary hover:underline">
                {SITE.contactEmail}
              </a>
              .
            </p>
          </div>

          <Accordion className="mt-12 w-full">
            {items.map((item, i) => (
              <AccordionItem key={i} value={`item-${i}`}>
                <AccordionTrigger className="text-left text-base font-medium">
                  {item.q}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground text-sm leading-relaxed">
                  {item.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </section>
  );
}

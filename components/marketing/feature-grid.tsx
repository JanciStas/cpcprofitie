import {
  BarChart3,
  Bell,
  Car,
  GitCompare,
  LineChart,
  Sparkles,
  TrendingUp,
} from 'lucide-react';

const features = [
  {
    icon: BarChart3,
    title: 'Prehľad trhu',
    description:
      'Počty inzerátov, mediány cien a trendy po modeloch zo všetkých troch portálov, prepočítané každú noc.',
  },
  {
    icon: LineChart,
    title: 'Analýza modelu',
    description:
      'Cenová distribúcia (p25 / medián / p75), vývoj po týždňoch a podobné inzeráty v ponuke.',
  },
  {
    icon: GitCompare,
    title: 'Porovnanie',
    description:
      'Dva modely vedľa seba — počet inzerátov v ponuke a mediánová cena.',
  },
  {
    icon: Sparkles,
    title: 'AI inzerát',
    description:
      'Vygeneruje predajný titulok a popis podľa značky, výbavy a tónu (formálny / energický / krátky) za 10 sekúnd.',
  },
  {
    icon: Car,
    title: 'Moja garáž',
    description:
      'Evidujte autá na sklade a porovnajte ich cenu s aktuálnym trhom.',
  },
  {
    icon: Bell,
    title: 'Sledované modely',
    description:
      'Nastavte kritériá (model, rok, km, max. cena). Raz denne vám pošleme e-mail s novými zhodami.',
  },
  {
    icon: TrendingUp,
    title: 'Príležitosti a zlacnenia',
    description:
      'DealScore označí inzeráty výrazne pod trhovou cenou; pri modeloch vidíte, ako často a o koľko predajcovia zlacňujú.',
  },
];

export function FeatureGrid() {
  return (
    <section id="features" className="container mx-auto px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Sedem nástrojov, jeden dashboard
        </h2>
        <p className="text-muted-foreground mt-4 text-lg">
          Všetko, čo dealerský tím potrebuje na rozhodovanie podložené dátami — bez prepínania medzi
          piatimi nástrojmi.
        </p>
      </div>

      <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => {
          const Icon = feature.icon;
          return (
            <div
              key={feature.title}
              className="border-border/40 bg-card/30 hover:border-primary/40 hover:bg-card/60 group relative overflow-hidden rounded-xl border p-6 transition-all"
            >
              <div className="bg-primary/10 text-primary mb-4 flex size-10 items-center justify-center rounded-lg">
                <Icon className="size-5" />
              </div>
              <h3 className="text-lg font-semibold tracking-tight">{feature.title}</h3>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                {feature.description}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

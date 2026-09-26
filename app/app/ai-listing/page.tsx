import { AiListingForm } from '@/components/ai/ai-listing-form';
import { aiListingsAvailable } from '@/lib/ai/availability';

export const metadata = { title: 'AI Inzerát' };

export default function AiListingPage() {
  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">AI generovanie inzerátu</h1>
        <p className="text-muted-foreground text-sm">
          Zadajte parametre vozidla — AI vygeneruje titulok a popis za pár sekúnd.
        </p>
      </div>

      <div className="mt-8">
        {aiListingsAvailable() ? (
          <AiListingForm />
        ) : (
          <div className="border-border/60 rounded-lg border p-10 text-center">
            <p className="text-muted-foreground text-sm">
              AI generovanie inzerátov momentálne nie je dostupné. Pracujeme na tom.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

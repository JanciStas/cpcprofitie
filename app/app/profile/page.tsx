import Link from 'next/link';
import { LogOut } from 'lucide-react';
import { SITE } from '@/lib/site';
import { getCurrentUser } from '@/lib/auth/server';

export const metadata = { title: 'Profil' };

const PROVIDER_LABELS: Record<string, string> = {
  email: 'E-mail a heslo',
  google: 'Google OAuth',
};

export default async function ProfilePage() {
  const user = await getCurrentUser();
  const provider = user?.app_metadata?.provider;
  const signInMethod = provider ? (PROVIDER_LABELS[provider] ?? provider) : '—';

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight">Profil</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Váš účet, plán a upozornenia.
        </p>

        <section className="border-border/40 bg-card/30 mt-8 rounded-xl border p-6">
          <h2 className="text-base font-semibold tracking-tight">Identita</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <Row label="E-mail" value={user?.email ?? '—'} />
            <Row label="ID účtu" value={user?.id ?? '—'} mono />
            <Row label="Spôsob prihlásenia" value={signInMethod} />
          </dl>
        </section>

        <section className="border-border/40 bg-card/30 mt-6 rounded-xl border p-6">
          <h2 className="text-base font-semibold tracking-tight">Plán</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Počas bety máte CPCProfit zadarmo.{' '}
            <Link href="/app/billing" className="text-primary hover:underline">
              Využitie limitov
            </Link>
          </p>
        </section>

        {/* These alerts do run: the watchlist cron at 06:00 UTC and the Monday
            digest. They used to be listed here as "(čoskoro)" behind disabled
            toggles that saved nothing. The switch that controls them lives on
            each watchlist entry, so point there instead of faking a setting. */}
        <section className="border-border/40 bg-card/30 mt-6 rounded-xl border p-6">
          <h2 className="text-base font-semibold tracking-tight">Upozornenia</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            E-mail s novými zhodami chodí raz denne pre každý sledovaný model, ktorý má zapnuté
            upozornenia. V pondelok k tomu posielame týždenný súhrn trhu.{' '}
            <Link href="/app/watchlist" className="text-primary hover:underline">
              Spravovať sledované modely
            </Link>
          </p>
        </section>

        <section className="border-border/40 bg-card/30 mt-6 rounded-xl border p-6">
          <h2 className="text-base font-semibold tracking-tight">Vaše údaje</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Kópiu svojich údajov alebo zmazanie účtu si vyžiadate na{' '}
            <a href={`mailto:${SITE.privacyEmail}`} className="text-primary hover:underline">
              {SITE.privacyEmail}
            </a>
            . Vybavíme to do 30 dní.
          </p>
        </section>

        <section className="border-destructive/30 bg-destructive/5 mt-8 rounded-xl border p-6">
          <h2 className="text-destructive text-base font-semibold tracking-tight">Nebezpečná zóna</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Odhlásenie ukončí aktuálnu reláciu. Vaše dáta zostanú nedotknuté.
          </p>
          <form action="/auth/sign-out" method="post" className="mt-4">
            <button
              type="submit"
              className="border-destructive/40 text-destructive hover:bg-destructive/10 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium"
            >
              <LogOut className="size-4" />
              Odhlásiť
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-xs' : ''}>{value}</dd>
    </div>
  );
}

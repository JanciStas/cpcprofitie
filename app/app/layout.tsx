import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/server';
import { MobileNav } from '@/components/app/mobile-nav';
import { ThemeToggle } from '@/components/theme-toggle';
import { aiListingsAvailable } from '@/lib/ai/availability';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-border/40 bg-background/80 sticky top-0 z-40 border-b backdrop-blur-md">
        <div className="container mx-auto flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <MobileNav aiAvailable={aiListingsAvailable()} />
            <Link href="/app/overview" className="flex items-center gap-2">
              <span className="from-primary to-chart-2 flex size-7 items-center justify-center rounded-md bg-gradient-to-br text-xs font-bold text-white">
                C
              </span>
              <span className="text-sm font-semibold tracking-tight">CPCProfit</span>
            </Link>
          </div>
          <nav className="hidden items-center gap-6 md:flex">
            {[
              { href: '/app/overview', label: 'Prehľad' },
              { href: '/app/trends', label: 'Trendy' },
              { href: '/app/deals', label: 'Deals' },
              { href: '/app/market', label: 'Trh' },
              { href: '/app/listings', label: 'Inzeráty' },
              { href: '/app/garage', label: 'Garáž' },
              { href: '/app/watchlist', label: 'Watchlist' },
              ...(aiListingsAvailable() ? [{ href: '/app/ai-listing', label: 'AI inzerát' }] : []),
              // Profile and plan used to exist only in the mobile menu, so a
              // desktop user had no way to reach their account at all.
              { href: '/app/profile', label: 'Účet' },
            ].map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-muted-foreground hover:text-foreground text-sm font-medium transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            {user ? (
              <>
                <span className="text-muted-foreground hidden text-xs sm:inline">{user.email}</span>
                <form action="/auth/sign-out" method="post">
                  <button
                    type="submit"
                    className="border-border/60 hover:bg-muted rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
                  >
                    Odhlásiť
                  </button>
                </form>
              </>
            ) : (
              // Market pages are public, so visitors arrive here signed out.
              // They used to see "hosť" and a sign-out button.
              <Link
                href="/login"
                className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-xs font-medium"
              >
                Prihlásiť sa
              </Link>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

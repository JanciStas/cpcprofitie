'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';

const links = [
  { href: '/app/overview', label: 'Prehľad' },
  { href: '/app/trends', label: 'Trendy' },
  { href: '/app/deals', label: 'Deals' },
  { href: '/app/market', label: 'Trh' },
  { href: '/app/listings', label: 'Inzeráty' },
  { href: '/app/garage', label: 'Garáž' },
  { href: '/app/watchlist', label: 'Watchlist' },
  { href: '/app/ai-listing', label: 'AI inzerát' },
  { href: '/app/profile', label: 'Účet' },
];

export function MobileNav({ aiAvailable = true }: { aiAvailable?: boolean }) {
  const visible = aiAvailable ? links : links.filter((l) => l.href !== '/app/ai-listing');
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="Otvoriť menu"
        onClick={() => setOpen(true)}
        className="border-border/60 hover:bg-muted inline-flex size-8 items-center justify-center rounded-md border md:hidden"
      >
        <Menu className="size-4" />
      </button>

      {open && (
        <div
          className="bg-background/95 fixed inset-0 z-50 backdrop-blur md:hidden"
          onClick={() => setOpen(false)}
        >
          <div
            className="border-border/40 bg-card flex h-full w-72 flex-col border-r p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold tracking-tight">Menu</span>
              <button
                type="button"
                aria-label="Zatvoriť"
                onClick={() => setOpen(false)}
                className="hover:bg-muted text-muted-foreground inline-flex size-8 items-center justify-center rounded-md"
              >
                <X className="size-4" />
              </button>
            </div>
            <nav className="mt-6 flex flex-col gap-1">
              {visible.map((link) => {
                const active = pathname === link.href || pathname.startsWith(link.href + '/');
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className={
                      active
                        ? 'bg-primary/10 text-primary rounded-md px-3 py-2 text-sm font-medium'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground rounded-md px-3 py-2 text-sm font-medium transition-colors'
                    }
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}

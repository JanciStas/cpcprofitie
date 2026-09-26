import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Analytics } from '@vercel/analytics/next';
import { getAppUrl } from '@/lib/app-url';
import { Toaster } from 'sonner';
import { CookiesBanner } from '@/components/cookies-banner';
import { ThemeProvider } from '@/components/theme-provider';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(getAppUrl()),
  title: {
    default: 'CPCProfit — Dáta pre obchodníkov s vozidlami',
    template: '%s · CPCProfit',
  },
  description:
    'Cenové analýzy, porovnania modelov, sledovanie trhu a AI generovanie inzerátov pre slovenských predajcov áut.',
  keywords: [
    'autobazár',
    'analýza áut',
    'cenník áut',
    'predaj áut',
    'AI inzerát',
    'autobazar.sk',
    'trh áut Slovensko',
  ],
  openGraph: {
    type: 'website',
    locale: 'sk_SK',
    siteName: 'CPCProfit',
  },
  twitter: { card: 'summary_large_image' },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground flex min-h-full flex-col">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
          <NextIntlClientProvider messages={messages}>
            {children}
            <CookiesBanner />
            <Toaster theme="dark" richColors closeButton />
          </NextIntlClientProvider>
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}

// Weekly market digest e-mail. Rendered server-side via render() in
// lib/notifications/weekly-digest.ts. Content is global (same for all
// recipients in v1) — top models by demand with WoW movement.

import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import type { TrendRow } from '@/lib/db/queries/trends';

export const DIGEST_SUBJECT = 'Týždenný prehľad trhu — CPCProfit';

function wowArrow(current: number | null, previous: number | null): string {
  if (current == null || previous == null || previous === 0) return '';
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return ' (bez zmeny)';
  return pct > 0 ? ` (▲ +${pct} %)` : ` (▼ ${pct} %)`;
}

export function WeeklyDigestEmail({ trends, appUrl }: { trends: TrendRow[]; appUrl: string }) {
  return (
    <Html lang="sk">
      <Head />
      <Preview>Top modely tohto týždňa a pohyby mediánových cien.</Preview>
      <Body style={{ backgroundColor: '#f6f6f6', fontFamily: 'Arial, sans-serif' }}>
        <Container
          style={{
            backgroundColor: '#ffffff',
            borderRadius: 12,
            margin: '24px auto',
            maxWidth: 560,
            padding: 24,
          }}
        >
          <Heading as="h1" style={{ fontSize: 20, margin: '0 0 4px' }}>
            Týždenný prehľad trhu
          </Heading>
          <Text style={{ color: '#555', fontSize: 14, margin: '0 0 16px' }}>
            Najžiadanejšie modely a pohyb mediánových cien za posledný týždeň.
          </Text>

          {trends.length === 0 ? (
            <Text style={{ fontSize: 13 }}>
              Tento týždeň zatiaľ nemáme dosť dát — snapshoty sa počítajú každú nedeľu.
            </Text>
          ) : (
            trends.map((t, i) => (
              <Section key={t.modelSlug} style={{ marginBottom: 10 }}>
                <Text style={{ fontSize: 13, margin: 0 }}>
                  <strong>
                    {i + 1}. {t.modelName}
                  </strong>
                  {' — '}
                  {t.countActive} aktívnych{wowArrow(t.countActive, t.countActiveLastWeek)}
                  {t.medianPriceEur != null
                    ? ` · medián ${t.medianPriceEur.toLocaleString('sk-SK')} €${wowArrow(
                        t.medianPriceEur,
                        t.medianLastWeekEur,
                      )}`
                    : ''}
                  {' · '}
                  <Link href={`${appUrl}/app/trends/${t.makeSlug}-${t.modelSlug}`} style={{ color: '#2563eb' }}>
                    detail
                  </Link>
                </Text>
              </Section>
            ))
          )}

          <Hr style={{ borderColor: '#e5e5e5', margin: '16px 0' }} />
          <Text style={{ color: '#888', fontSize: 12, margin: 0 }}>
            Digest dostávate, lebo máte aktívne sledovanie s e-mail alertami. Vypnúť ho môžete na{' '}
            <Link href={`${appUrl}/app/watchlist`} style={{ color: '#2563eb' }}>
              stránke Sledované modely
            </Link>
            .
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

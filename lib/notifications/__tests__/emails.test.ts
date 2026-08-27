import { describe, expect, it } from 'vitest';
import { render } from '@react-email/components';
import {
  WatchlistAlertEmail,
  alertSubject,
  buildAlertGroups,
  type AlertListing,
} from '@/emails/watchlist-alert';
import { DIGEST_SUBJECT, WeeklyDigestEmail } from '@/emails/weekly-digest';
import type { TrendRow } from '@/lib/db/queries/trends';

const APP_URL = 'https://cpcprofitie.vercel.app';

function listing(i: number): AlertListing {
  return {
    title: `Škoda Octavia ${i}`,
    priceEur: 10_000 + i,
    year: 2019,
    mileageKm: 120_000,
    url: `https://auto.bazos.sk/inzerat/${i}`,
  };
}

describe('buildAlertGroups', () => {
  it('caps shown listings at 10 and reports the remainder', () => {
    const groups = buildAlertGroups([
      { watchLabel: 'Octavia · do 15 000 €', listings: Array.from({ length: 14 }, (_, i) => listing(i)) },
    ]);
    expect(groups[0].listings).toHaveLength(10);
    expect(groups[0].extraCount).toBe(4);
  });

  it('keeps small groups intact', () => {
    const groups = buildAlertGroups([{ watchLabel: 'X', listings: [listing(1)] }]);
    expect(groups[0].listings).toHaveLength(1);
    expect(groups[0].extraCount).toBe(0);
  });
});

describe('alertSubject', () => {
  it('mentions the total count', () => {
    expect(alertSubject(7)).toBe('Nové inzeráty pre vaše sledovania (7)');
  });
});

describe('WatchlistAlertEmail render', () => {
  it('renders Slovak copy, listing rows, and the watchlist link', async () => {
    const groups = buildAlertGroups([
      { watchLabel: 'Škoda Octavia · Bratislavský kraj', listings: [listing(1), listing(2)] },
    ]);
    const html = await render(WatchlistAlertEmail({ groups, appUrl: APP_URL }));
    expect(html).toContain('Nové inzeráty pre vaše sledovania');
    expect(html).toContain('Škoda Octavia 1');
    expect(html).toContain('Bratislavský kraj');
    expect(html).toContain(`${APP_URL}/app/watchlist`);
  });
});

describe('WeeklyDigestEmail render', () => {
  const trend: TrendRow = {
    modelId: 1,
    makeSlug: 'skoda',
    modelSlug: 'skoda-octavia',
    modelName: 'Škoda Octavia',
    countActive: 120,
    countActiveLastWeek: 100,
    countSoldThisWeek: 8,
    medianPriceEur: 13_500,
    medianLastWeekEur: 14_000,
    daysToSellAvg: 21,
    priceCutRate: null,
    cutDepthPct: null,
    priceRaises: 0,
  };

  it('renders trends with WoW arrows and links', async () => {
    const html = await render(WeeklyDigestEmail({ trends: [trend], appUrl: APP_URL }));
    expect(html).toContain('Týždenný prehľad trhu');
    expect(html).toContain('Škoda Octavia');
    expect(html).toContain('+20'); // count WoW: 100 → 120
    expect(html).toContain(`${APP_URL}/app/trends/skoda-octavia`);
  });

  it('renders the empty state without data', async () => {
    const html = await render(WeeklyDigestEmail({ trends: [], appUrl: APP_URL }));
    expect(html).toContain('nemáme dosť dát');
  });

  it('has a stable subject', () => {
    expect(DIGEST_SUBJECT).toContain('Týždenný prehľad');
  });
});

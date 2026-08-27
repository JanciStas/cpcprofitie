import Link from 'next/link';
import type { TrendRow } from '@/lib/db/queries/trends';
import { WowArrow } from './wow-arrow';

const NBSP = ' ';

function fmtPrice(eur: number | null): string {
  if (eur == null) return '—';
  return `${eur.toLocaleString('sk-SK')}${NBSP}€`;
}

function fmtCount(n: number | null): string {
  if (n == null) return '—';
  return n.toLocaleString('sk-SK');
}

/**
 * A rate we do not have enough evidence for renders EMPTY, not as a dash.
 *
 * fmtPrice and fmtCount use a dash because a missing price is a hole in a
 * number we do genuinely track. A missing cut rate is different: the gates in
 * priceCutRate withheld it on purpose, and a dash in a column of percentages
 * reads as "this model does not discount", which is the opposite of what it
 * means. Same reasoning as the removed sold columns below.
 */
function fmtPct(v: number | null, digits = 1): string {
  if (v == null) return '';
  return `${(v * 100).toFixed(digits)}${NBSP}%`;
}

// "Zlacnilo" is the share of a model's listings that cut their price in a week,
// measured against listing-time we ACTUALLY READ A PRICE FOR -- not against a
// count of cars. A listing priced once contributes nothing, because we cannot
// know whether it moved. It is deliberately not called anything with "sale" in
// it: a price cut is a price cut, and how many of those cars then sold is a
// question this column does not answer.
//
// "Predané (7d)" and "Days-to-sell" used to live here. They are gone rather
// than blanked, because the numbers behind them were not measurements: 93% of
// recorded sales were listings already dead the first time we fetched them, and
// even the genuine ones are left-censored — first_seen_at is when we started
// looking, not when the advert appeared, and 87 648 of 87 917 rows predate our
// corpus. A column of dashes would still promise that the metric exists and is
// merely sparse. They come back when there are sales we watched happen.
export function TrendsTable({ rows }: { rows: TrendRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="border-border/60 rounded-lg border p-10 text-center">
        <p className="text-muted-foreground text-sm">
          Žiadne dáta. Snapshoty sa generujú týždenne — počkajte na prvý beh weekly cron-u.
        </p>
      </div>
    );
  }
  return (
    <div className="border-border/60 overflow-hidden rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/30 border-border/40 border-b text-xs uppercase">
          <tr>
            <th className="px-4 py-3 text-left font-medium">Model</th>
            <th className="px-4 py-3 text-right font-medium">Aktívne</th>
            <th className="px-4 py-3 text-right font-medium">WoW</th>
            <th className="px-4 py-3 text-right font-medium">Medián ceny</th>
            <th className="px-4 py-3 text-right font-medium">Δ cena</th>
            <th className="px-4 py-3 text-right font-medium">Zlacnilo</th>
            <th className="px-4 py-3 text-right font-medium">Hĺbka zľavy</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.modelId}
              className="border-border/30 hover:bg-muted/20 border-b transition-colors last:border-b-0"
            >
              <td className="px-4 py-3">
                <Link
                  href={`/app/trends/${r.makeSlug}-${r.modelSlug}`}
                  className="hover:text-primary font-medium"
                >
                  {r.modelName}
                </Link>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{fmtCount(r.countActive)}</td>
              <td className="px-4 py-3 text-right">
                <WowArrow current={r.countActive} previous={r.countActiveLastWeek} />
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {fmtPrice(r.medianPriceEur)}
              </td>
              <td className="px-4 py-3 text-right">
                <WowArrow current={r.medianPriceEur} previous={r.medianLastWeekEur} invert />
              </td>
              <td
                className="px-4 py-3 text-right tabular-nums"
                title={
                  r.priceRaises > 0
                    ? `${r.priceRaises.toLocaleString('sk-SK')} inzerátov naopak zdraželo`
                    : undefined
                }
              >
                {fmtPct(r.priceCutRate)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {r.cutDepthPct != null && r.priceCutRate != null
                  ? `${r.cutDepthPct.toFixed(1)}${NBSP}%`
                  : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

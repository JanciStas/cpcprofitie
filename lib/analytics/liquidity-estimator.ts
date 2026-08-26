// The arithmetic behind "how fast does this model leave the market".
//
// Deliberately free of any database import so it can be tested against worked
// numbers, the way lib/scraping/aggregate.ts is. Everything here operates on
// counts and exposure that liquidity.ts has already measured.
//
// WHY AN OCCURRENCE-EXPOSURE RATE AND NOT A PROPORTION
//
// The obvious metric — disappeared ÷ active — is a numerator over a stock, and
// it is wrong in the one direction we cannot afford. A listing we have not
// looked at since Tuesday is counted as "still for sale" for the rest of the
// week, so every gap in our own crawling is recorded as market inactivity.
// That is the same class of error as the sales metric this project already had
// to pull: measuring our own latency and calling it the market.
//
// Instead each listing contributes TIME AT RISK, and that time stops at the
// last moment we actually confirmed it. A listing observed for two days
// contributes two listing-days, not seven. Cars still on sale contribute
// exposure and no event, so right-censoring needs no special handling and
// there is no way to write this estimator using only the ones that left —
// which is precisely how the last one went wrong.
//
// WHY NOT KAPLAN-MEIER. It needs each listing's age at every point, i.e.
// first_seen_alive_at, which a large and non-random share of the corpus lacks
// (it correlates with which catalogue pages the cursor happened to reach
// twice). A survival curve fitted on that is the survival function of our
// crawler. It is also pointless at this window length: with checks a week
// apart and a few weeks of history, every observation falls in one interval.

/** One model's measured flow, already pooled across weeks. */
export type FlowInput = {
  modelId: number;
  source: string;
  /** Events attributed to the window, reposts already subtracted. */
  events: number;
  /** Listing-weeks of observed time at risk. */
  exposureWeeks: number;
};

export type LiquidityEstimate = {
  modelId: number;
  /** Shrunken rate, share of listings leaving per week. */
  ratePerWeek: number;
  /** 95% interval on that rate. */
  lo: number;
  hi: number;
  events: number;
  exposureWeeks: number;
};

/**
 * Publish gates, applied on READ so they stay tunable.
 *
 * A row below either of these renders as nothing at all — not a dash. A dash
 * still promises the metric exists and is merely sparse, which is the mistake
 * documented in trends-table.tsx when the sold columns were removed.
 *
 * Expressed in exposure rather than in cars on purpose: as the observation
 * window lengthens the same threshold admits smaller models, with nothing to
 * re-argue. At one week only large models qualify; by week three a model with
 * 17 cars clears the same bar.
 */
export const MIN_EXPOSURE_WEEKS = 50;
export const MIN_EVENTS = 5;

/** Fallback prior strength, in listing-weeks, when the data cannot estimate it. */
export const DEFAULT_PRIOR_WEEKS = 200;
const PRIOR_MIN = 50;
const PRIOR_MAX = 1000;
/** Below this many models the method-of-moments estimate is too noisy to use. */
const MIN_MODELS_FOR_PRIOR = 30;

/** Global rate for a set of rows: total events over total exposure. */
export function globalRate(rows: readonly FlowInput[]): number {
  const e = rows.reduce((a, r) => a + r.exposureWeeks, 0);
  if (e <= 0) return 0;
  return rows.reduce((a, r) => a + r.events, 0) / e;
}

/**
 * Prior strength k, in listing-weeks, by method of moments.
 *
 * A model with 20 cars and 2 departures shows a raw rate of 0.10 and a model
 * with 300 cars and 25 shows 0.083; ranked raw, the small one wins on what is
 * mostly noise. Shrinking both toward the global rate in proportion to how
 * little exposure each carries fixes the ordering without a hand-tuned penalty:
 * k is large when models genuinely resemble each other and small when they
 * genuinely differ, and it is read off the spread in the data rather than
 * chosen.
 */
export function estimatePriorWeeks(rows: readonly FlowInput[]): number {
  const usable = rows.filter((r) => r.exposureWeeks > 0);
  if (usable.length < MIN_MODELS_FOR_PRIOR) return DEFAULT_PRIOR_WEEKS;
  const h0 = globalRate(usable);
  if (h0 <= 0) return DEFAULT_PRIOR_WEEKS;

  const sumE = usable.reduce((a, r) => a + r.exposureWeeks, 0);
  const sumE2 = usable.reduce((a, r) => a + r.exposureWeeks * r.exposureWeeks, 0);
  const weighted = usable.reduce((a, r) => {
    const rate = r.events / r.exposureWeeks;
    return a + r.exposureWeeks * (rate - h0) * (rate - h0);
  }, 0);
  const denom = sumE - sumE2 / sumE;
  if (denom <= 0) return DEFAULT_PRIOR_WEEKS;

  // Subtracting h0*(M-1) removes the variance that Poisson noise alone would
  // produce, leaving the genuine spread between models. When that comes out at
  // or below zero the models are indistinguishable and a strong prior is right.
  const tau2 = (weighted - h0 * (usable.length - 1)) / denom;
  if (!Number.isFinite(tau2) || tau2 <= 0) return DEFAULT_PRIOR_WEEKS;
  return clamp(h0 / tau2, PRIOR_MIN, PRIOR_MAX);
}

/**
 * Posterior rate and its interval for one row.
 *
 * The prior contributes h0*k pseudo-events, which for realistic values is
 * around nine, so the posterior count is never small and the log-transformed
 * Poisson interval is accurate without pulling in a gamma-quantile dependency.
 */
export function posteriorRate(row: FlowInput, h0: number, priorWeeks: number): LiquidityEstimate {
  const rate = (row.events + h0 * priorWeeks) / (row.exposureWeeks + priorWeeks);
  const pseudoEvents = row.events + h0 * priorWeeks;
  const spread = pseudoEvents > 0 ? Math.exp(1.96 / Math.sqrt(pseudoEvents)) : 1;
  return {
    modelId: row.modelId,
    ratePerWeek: rate,
    lo: rate / spread,
    hi: rate * spread,
    events: row.events,
    exposureWeeks: row.exposureWeeks,
  };
}

/**
 * Per-model rates, standardised across sources to the corpus-wide mix.
 *
 * Without this the ranking is mostly a ranking of sources. Private bazos.sk
 * adverts turn over on a completely different clock from dealer stock on
 * autobazar, so a model that happens to sit 80% on bazos.sk would read as more
 * in demand than an identical car listed mostly on autobazar.eu. Weighting each
 * source's rate by that source's share of total exposure asks the counterfactual
 * that matters: what would this model's rate be if it were spread across the
 * sources the way the corpus as a whole is.
 */
export function estimateLiquidity(rows: readonly FlowInput[]): LiquidityEstimate[] {
  // A source that has recorded exposure but not one departure has an instrument
  // that has not started yet, not a market where nothing sells. Measured on the
  // first real run: autobazar.eu carried 1 446 listing-weeks of Octavia and
  // zero events, because its historical removals were settled before those rows
  // were ever classified. Standardising against a stratum like that drags every
  // model's rate toward zero and calls our own gap a finding. Dropped here; the
  // weights renormalise below, and the source rejoins on its first event.
  const eventsBySource = new Map<string, number>();
  for (const r of rows) {
    eventsBySource.set(r.source, (eventsBySource.get(r.source) ?? 0) + r.events);
  }
  const usable = rows.filter((r) => (eventsBySource.get(r.source) ?? 0) > 0);
  if (usable.length === 0) return [];
  rows = usable;

  const bySource = new Map<string, FlowInput[]>();
  for (const r of rows) {
    const list = bySource.get(r.source);
    if (list) list.push(r);
    else bySource.set(r.source, [r]);
  }

  const totalExposure = rows.reduce((a, r) => a + r.exposureWeeks, 0);
  if (totalExposure <= 0) return [];

  const perSource = new Map<string, { h0: number; k: number; weight: number }>();
  for (const [source, list] of bySource) {
    const exposure = list.reduce((a, r) => a + r.exposureWeeks, 0);
    perSource.set(source, {
      h0: globalRate(list),
      k: estimatePriorWeeks(list),
      weight: exposure / totalExposure,
    });
  }

  const byModel = new Map<number, LiquidityEstimate>();
  for (const r of rows) {
    const params = perSource.get(r.source)!;
    const est = posteriorRate(r, params.h0, params.k);
    const acc = byModel.get(r.modelId);
    if (!acc) {
      byModel.set(r.modelId, {
        modelId: r.modelId,
        ratePerWeek: est.ratePerWeek * params.weight,
        lo: est.lo * params.weight,
        hi: est.hi * params.weight,
        events: r.events,
        exposureWeeks: r.exposureWeeks,
      });
    } else {
      acc.ratePerWeek += est.ratePerWeek * params.weight;
      acc.lo += est.lo * params.weight;
      acc.hi += est.hi * params.weight;
      acc.events += r.events;
      acc.exposureWeeks += r.exposureWeeks;
    }
  }

  // A model present on only some sources has weights summing to less than one,
  // which would understate it purely for being absent elsewhere. Renormalise to
  // the sources it actually appears on.
  const weightByModel = new Map<number, number>();
  for (const r of rows) {
    const w = perSource.get(r.source)!.weight;
    weightByModel.set(r.modelId, (weightByModel.get(r.modelId) ?? 0) + w);
  }
  for (const [modelId, est] of byModel) {
    const w = weightByModel.get(modelId) ?? 1;
    if (w > 0 && w < 1) {
      est.ratePerWeek /= w;
      est.lo /= w;
      est.hi /= w;
    }
  }

  return [...byModel.values()];
}

/** True when a row carries enough evidence to be shown at all. */
export function isPublishable(est: Pick<LiquidityEstimate, 'events' | 'exposureWeeks'>): boolean {
  return est.exposureWeeks >= MIN_EXPOSURE_WEEKS && est.events >= MIN_EVENTS;
}

export type Quadrant = 'strong-demand' | 'moves-on-price' | 'holding' | 'weak-demand';

/**
 * Where a model sits against its peers on the two measured axes.
 *
 * The label is derived, never measured, and the UI has to say so. Its value is
 * that the interesting cases are the disagreements: leaving fast with no
 * discounting is a different market from leaving fast only after price cuts,
 * and a single blended score would hide exactly that difference.
 */
export function quadrant(
  turnover: number,
  cutRate: number,
  medianTurnover: number,
  medianCutRate: number,
): Quadrant {
  const fast = turnover >= medianTurnover;
  const discounting = cutRate >= medianCutRate;
  if (fast && !discounting) return 'strong-demand';
  if (fast && discounting) return 'moves-on-price';
  if (!fast && !discounting) return 'holding';
  return 'weak-demand';
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

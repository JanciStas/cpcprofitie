import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRIOR_WEEKS,
  MIN_EVENTS,
  MIN_EXPOSURE_WEEKS,
  estimateLiquidity,
  estimatePriorWeeks,
  globalRate,
  isPublishable,
  posteriorRate,
  priceCutRate,
  MIN_PRICE_CUTS,
  MIN_PRICE_EXPOSURE_WEEKS,
  quadrant,
} from '../liquidity-estimator';

const row = (modelId: number, events: number, exposureWeeks: number, source = 'bazos.sk') => ({
  modelId,
  source,
  events,
  exposureWeeks,
});

describe('shrinkage puts the ranking the right way round', () => {
  it('ranks the big cohort above the small one that looks faster raw', () => {
    // The failure this whole module exists to prevent. Twenty cars with two
    // departures is a raw rate of 0.100; three hundred cars with twenty-five is
    // 0.083. Ranked raw, the small cohort wins on what is almost entirely
    // noise, and the trends table would recommend it.
    const small = row(1, 2, 20);
    const big = row(2, 25, 300);
    expect(small.events / small.exposureWeeks).toBeGreaterThan(big.events / big.exposureWeeks);

    const h0 = 0.06;
    const k = 150;
    const a = posteriorRate(small, h0, k);
    const b = posteriorRate(big, h0, k);
    expect(b.ratePerWeek).toBeGreaterThan(a.ratePerWeek);
  });

  it('gives the thin cohort a visibly wider interval', () => {
    const a = posteriorRate(row(1, 2, 20), 0.06, 150);
    const b = posteriorRate(row(2, 25, 300), 0.06, 150);
    expect(a.hi - a.lo).toBeGreaterThan(b.hi - b.lo);
  });

  it('pulls a zero-event cohort toward the global rate, not to zero', () => {
    // Never seeing a departure is not evidence that none happen; with thin
    // exposure it is the expected outcome. Reporting 0% would read as a dead
    // model.
    const est = posteriorRate(row(1, 0, 10), 0.06, 150);
    expect(est.ratePerWeek).toBeGreaterThan(0.05);
    expect(est.ratePerWeek).toBeLessThan(0.06);
  });

  it('leaves a cohort with heavy exposure almost unshrunk', () => {
    // Shrinkage is a correction for thin evidence. With plenty of it the
    // estimate must stay close to what was measured, or the metric would only
    // ever report the global average back.
    const est = posteriorRate(row(1, 300, 3000), 0.06, 150);
    expect(est.ratePerWeek).toBeCloseTo(0.1, 2);
  });
});

describe('the prior is read off the data', () => {
  it('falls back when there are too few models to estimate from', () => {
    const rows = [row(1, 5, 100), row(2, 6, 100)];
    expect(estimatePriorWeeks(rows)).toBe(DEFAULT_PRIOR_WEEKS);
  });

  it('uses a strong prior when models are indistinguishable', () => {
    // Every model at the same rate: the spread between them is pure Poisson
    // noise, so individual estimates deserve little weight.
    const rows = Array.from({ length: 40 }, (_, i) => row(i, 6, 100));
    expect(estimatePriorWeeks(rows)).toBe(DEFAULT_PRIOR_WEEKS);
  });

  it('uses a weaker prior when models genuinely differ', () => {
    // Half the models churn ten times faster than the other half. That spread
    // is real, so the estimator must trust the per-model numbers more.
    const rows = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? row(i, 1, 100) : row(i, 30, 100),
    );
    expect(estimatePriorWeeks(rows)).toBeLessThan(DEFAULT_PRIOR_WEEKS);
  });

  it('never returns a prior outside its clamp', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i, i, 100));
    const k = estimatePriorWeeks(rows);
    expect(k).toBeGreaterThanOrEqual(50);
    expect(k).toBeLessThanOrEqual(1000);
  });
});

describe('source mix', () => {
  it('does not let one source decide a model rank', () => {
    // Two models with identical behaviour within every source they share. One
    // happens to sit mostly on the fast-churning source. Standardising to the
    // corpus mix must leave them level; a pooled raw rate would not.
    const rows = [
      // fast source
      row(1, 90, 900, 'bazos.sk'),
      row(2, 10, 100, 'bazos.sk'),
      // slow source
      row(1, 10, 1000, 'autobazar.eu'),
      row(2, 90, 9000, 'autobazar.eu'),
    ];
    const [a, b] = estimateLiquidity(rows).sort((x, y) => x.modelId - y.modelId);
    expect(a!.ratePerWeek).toBeCloseTo(b!.ratePerWeek, 3);
  });

  it('does not penalise a model for being absent from a source', () => {
    // Renormalisation: appearing on one source only must not halve the rate.
    const rows = [
      row(1, 50, 500, 'bazos.sk'),
      row(2, 50, 500, 'bazos.sk'),
      row(2, 50, 500, 'autobazar.eu'),
    ];
    const est = estimateLiquidity(rows);
    const one = est.find((e) => e.modelId === 1)!;
    expect(one.ratePerWeek).toBeGreaterThan(0.05);
  });

  it('ignores a source that has recorded no departure at all', () => {
    // Measured: autobazar.eu carried 1 446 listing-weeks of Skoda Octavia and
    // zero events, because its historical removals were settled before those
    // rows were ever classified. That is an instrument that has not started,
    // not a market where nothing sells, and standardising against it would drag
    // every model toward zero and publish our own gap as a finding.
    const withDeadSource = [
      row(1, 50, 500, 'bazos.sk'),
      row(1, 0, 5000, 'autobazar.eu'),
    ];
    const [est] = estimateLiquidity(withDeadSource);
    expect(est!.ratePerWeek).toBeGreaterThan(0.05);
  });

  it('returns nothing when every source is silent', () => {
    expect(estimateLiquidity([row(1, 0, 500, 'bazos.sk')])).toEqual([]);
  });

  it('returns nothing when there is no exposure at all', () => {
    expect(estimateLiquidity([row(1, 0, 0)])).toEqual([]);
  });
});

describe('publish gates', () => {
  it('refuses a cohort with too little exposure', () => {
    expect(isPublishable({ events: 99, exposureWeeks: MIN_EXPOSURE_WEEKS - 1 })).toBe(false);
  });

  it('refuses a cohort with too few events', () => {
    expect(isPublishable({ events: MIN_EVENTS - 1, exposureWeeks: 10_000 })).toBe(false);
  });

  it('admits one that clears both', () => {
    expect(isPublishable({ events: MIN_EVENTS, exposureWeeks: MIN_EXPOSURE_WEEKS })).toBe(true);
  });

  it('keeps the 20-car, 2-event example out entirely in week one', () => {
    // The strongest possible answer to "it must not outrank the big cohort":
    // in a one-week window it is not shown at all.
    expect(isPublishable({ events: 2, exposureWeeks: 20 })).toBe(false);
  });
});

describe('global rate', () => {
  it('is total events over total exposure, not a mean of rates', () => {
    // An unweighted mean of per-model rates would give the tiny cohort the same
    // say as the huge one -- the same bug that was found in the weekly trends
    // query, where AVG(median_price) stood in for a median.
    const rows = [row(1, 1, 1), row(2, 10, 999)];
    expect(globalRate(rows)).toBeCloseTo(11 / 1000, 6);
  });

  it('is zero when nothing was observed', () => {
    expect(globalRate([])).toBe(0);
  });
});

describe('price-cut rate', () => {
  it('divides by observed price time, not by cars', () => {
    // Two models with the same number of cuts but one watched twice as long
    // must not read the same. Counting cars instead would say they do.
    const short = priceCutRate(20, 100)!;
    const long = priceCutRate(20, 200)!;
    expect(short).toBeCloseTo(0.2, 6);
    expect(long).toBeCloseTo(0.1, 6);
    expect(short).toBeGreaterThan(long);
  });

  it('says nothing when there are too few cuts', () => {
    // Three observed cuts is not "the model that discounts most".
    expect(priceCutRate(MIN_PRICE_CUTS - 1, 10_000)).toBeNull();
  });

  it('says nothing when the price series is too thin', () => {
    expect(priceCutRate(500, MIN_PRICE_EXPOSURE_WEEKS - 1)).toBeNull();
  });

  it('answers once both gates are cleared', () => {
    expect(priceCutRate(MIN_PRICE_CUTS, MIN_PRICE_EXPOSURE_WEEKS)).toBeCloseTo(0.1, 6);
  });

  it('never divides by zero', () => {
    expect(priceCutRate(10, 0)).toBeNull();
  });
});

describe('quadrant labels', () => {
  it('names each corner', () => {
    expect(quadrant(0.1, 0.01, 0.05, 0.05)).toBe('strong-demand');
    expect(quadrant(0.1, 0.1, 0.05, 0.05)).toBe('moves-on-price');
    expect(quadrant(0.01, 0.01, 0.05, 0.05)).toBe('holding');
    expect(quadrant(0.01, 0.1, 0.05, 0.05)).toBe('weak-demand');
  });
});

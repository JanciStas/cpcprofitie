import { describe, expect, it } from 'vitest';
import { detailPriceIsUsable } from '../persist';
import { PRICE_MAX, PRICE_MIN } from '@/lib/analytics/quality';

// A price read off a detail page now OVERWRITES the stored one and stamps
// price_checked_at, instead of filling a gap and leaving the stamp alone.
//
// Why that mattered: bazos.sk repeats its last page past a certain depth
// (offsets 60 000 and 120 000 return the identical twenty adverts), so the
// catalogue walk reaches roughly 20 000 of its 60 000 active listings. The
// detail pass goes by id and has no depth ceiling, so it was the only path that
// could refresh the other ~40 000 -- and with coalesce it refreshed neither the
// price nor the timestamp. Those prices were frozen for good while still
// counting in the reference medians.
//
// Overwriting makes the bounds load-bearing, which is what this pins.
describe('detailPriceIsUsable', () => {
  it('takes an ordinary price', () => {
    expect(detailPriceIsUsable(12_500)).toBe(true);
  });

  it('refuses a missing price rather than writing a hole', () => {
    expect(detailPriceIsUsable(null)).toBe(false);
    expect(detailPriceIsUsable(undefined)).toBe(false);
  });

  it('refuses a value under the floor', () => {
    // "Cena dohodou" parses down to single digits on some sources.
    expect(detailPriceIsUsable(PRICE_MIN - 1)).toBe(false);
    expect(detailPriceIsUsable(PRICE_MIN)).toBe(true);
  });

  it('refuses a value over the ceiling', () => {
    // autobazar.eu validates only a floor at parse time, so the ceiling has to
    // be enforced here or a misplaced decimal reaches the medians.
    expect(detailPriceIsUsable(PRICE_MAX + 1)).toBe(false);
    expect(detailPriceIsUsable(PRICE_MAX)).toBe(true);
  });

  it('refuses a nonsensical number', () => {
    expect(detailPriceIsUsable(0)).toBe(false);
    expect(detailPriceIsUsable(-5_000)).toBe(false);
  });
});

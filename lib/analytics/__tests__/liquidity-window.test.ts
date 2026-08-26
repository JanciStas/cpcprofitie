import { describe, expect, it } from 'vitest';
import { isoWeekBounds } from '../liquidity';

// The window edges decide which departures land in which week. Getting the
// boundary wrong shifts events relative to the exposure they must be divided
// by, which is the one arithmetic error an occurrence-exposure rate cannot
// absorb.
describe('isoWeekBounds', () => {
  it('starts the week on Monday 00:00 UTC', () => {
    // 2026-08-26 is a Wednesday.
    const { start, end } = isoWeekBounds(new Date('2026-08-26T13:45:00Z'));
    expect(start.toISOString()).toBe('2026-08-24T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-31T00:00:00.000Z');
  });

  it('treats Monday itself as the first day, not the last', () => {
    const { start } = isoWeekBounds(new Date('2026-08-24T00:00:01Z'));
    expect(start.toISOString()).toBe('2026-08-24T00:00:00.000Z');
  });

  it('keeps Sunday in the week that began six days earlier', () => {
    // Sunday is where an off-by-one shows up: getUTCDay() calls it 0, so a
    // naive shift would move it forward into the following week.
    const { start } = isoWeekBounds(new Date('2026-08-30T23:59:59Z'));
    expect(start.toISOString()).toBe('2026-08-24T00:00:00.000Z');
  });

  it('spans exactly seven days', () => {
    const { start, end } = isoWeekBounds(new Date('2026-08-26T13:45:00Z'));
    expect(end.getTime() - start.getTime()).toBe(7 * 86_400_000);
  });

  it('crosses a month boundary without drifting', () => {
    const { start, end } = isoWeekBounds(new Date('2026-09-01T10:00:00Z'));
    expect(start.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-07T00:00:00.000Z');
  });
});

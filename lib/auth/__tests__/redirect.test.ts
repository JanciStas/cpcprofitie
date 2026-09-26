import { describe, expect, it } from 'vitest';
import { safeNextPath } from '../redirect';

describe('safeNextPath', () => {
  it('accepts same-origin paths starting with a single slash', () => {
    expect(safeNextPath('/app/overview')).toBe('/app/overview');
    expect(safeNextPath('/app/analysis/skoda-octavia')).toBe('/app/analysis/skoda-octavia');
  });

  it('rejects protocol-relative URLs', () => {
    expect(safeNextPath('//evil.com')).toBe('/app/overview');
    expect(safeNextPath('//evil.com/app/overview')).toBe('/app/overview');
  });

  it('rejects absolute external URLs', () => {
    expect(safeNextPath('https://evil.com')).toBe('/app/overview');
    expect(safeNextPath('http://evil.com/app/overview')).toBe('/app/overview');
  });

  it('rejects javascript: and data: schemes', () => {
    expect(safeNextPath('javascript:alert(1)')).toBe('/app/overview');
    expect(safeNextPath('data:text/html,<script>')).toBe('/app/overview');
  });

  it('rejects header-injection candidates', () => {
    expect(safeNextPath('/app/overview\nSet-Cookie: x=1')).toBe('/app/overview');
    expect(safeNextPath('/app/\r\nfoo')).toBe('/app/overview');
  });

  it('falls back when input is null/empty', () => {
    expect(safeNextPath(null)).toBe('/app/overview');
    expect(safeNextPath('')).toBe('/app/overview');
    expect(safeNextPath(undefined)).toBe('/app/overview');
  });

  it('honours a custom fallback', () => {
    expect(safeNextPath(null, '/app/billing')).toBe('/app/billing');
    expect(safeNextPath('//attacker', '/app/billing')).toBe('/app/billing');
  });
});

describe('safeNextPath — backslash', () => {
  it('rejects a backslash that browsers turn into a second slash', () => {
    // `/\evil.com` passed the single-slash check, and every browser treats it
    // as `//evil.com`: a freshly logged-in user was sent off-site.
    const bs = String.fromCharCode(92);
    expect(safeNextPath(`/${bs}evil.com`)).toBe('/app/overview');
    expect(safeNextPath(`/app${bs}..${bs}x`)).toBe('/app/overview');
  });

  it('still accepts an ordinary path', () => {
    expect(safeNextPath('/app/deals?sort=discount')).toBe('/app/deals?sort=discount');
  });
});

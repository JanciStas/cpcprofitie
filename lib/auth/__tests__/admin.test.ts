import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAdminRequestOrigin, isAdminUser } from '../admin';

const req = (h: Record<string, string>) =>
  new Request('https://cpcprofitie.vercel.app/api/admin/recluster', { headers: h });

describe('isAdminUser', () => {
  const prev = process.env.ADMIN_EMAILS;
  beforeEach(() => {
    process.env.ADMIN_EMAILS = 'boss@example.com';
  });
  afterEach(() => {
    process.env.ADMIN_EMAILS = prev;
  });

  it('refuses an allowlisted address nobody has confirmed', () => {
    // Sign-up does not require confirmation, so an allowlisted address not yet
    // registered could be claimed by whoever types it in first.
    expect(isAdminUser({ email: 'boss@example.com', email_confirmed_at: null })).toBe(false);
  });

  it('accepts a confirmed allowlisted address', () => {
    expect(
      isAdminUser({ email: 'Boss@Example.com', email_confirmed_at: '2026-09-01T00:00:00Z' }),
    ).toBe(true);
  });

  it('refuses a confirmed address that is not on the list', () => {
    expect(isAdminUser({ email: 'x@example.com', email_confirmed_at: '2026-09-01T00:00:00Z' })).toBe(
      false,
    );
  });

  it('refuses nobody', () => {
    expect(isAdminUser(null)).toBe(false);
  });
});

describe('isAdminRequestOrigin', () => {
  it('refuses a request navigated to from another site', () => {
    // A SameSite=Lax cookie rides along on top-level navigation, so a link on
    // a foreign page could otherwise trigger recluster?reset=1.
    expect(isAdminRequestOrigin(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('accepts same-origin requests and a typed URL', () => {
    expect(isAdminRequestOrigin(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isAdminRequestOrigin(req({ 'sec-fetch-site': 'none' }))).toBe(true);
  });

  it('falls back to the referer when fetch metadata is missing', () => {
    expect(
      isAdminRequestOrigin(
        req({ host: 'cpcprofitie.vercel.app', referer: 'https://cpcprofitie.vercel.app/app' }),
      ),
    ).toBe(true);
    expect(
      isAdminRequestOrigin(req({ host: 'cpcprofitie.vercel.app', referer: 'https://evil.test/' })),
    ).toBe(false);
  });
});

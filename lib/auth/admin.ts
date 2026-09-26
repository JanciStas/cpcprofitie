// Admin allowlist shared by the admin API routes and /app/admin pages.
// Empty or unset ADMIN_EMAILS means nobody is admin (fail closed).

export function parseAdminAllowlist(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowlist = parseAdminAllowlist();
  return allowlist.length > 0 && allowlist.includes(email.toLowerCase());
}

type MaybeUser = { email?: string | null; email_confirmed_at?: string | null } | null | undefined;

/**
 * Admin = on the allowlist AND owns the address.
 *
 * Email confirmation is off for sign-ups, so an address on ADMIN_EMAILS that
 * nobody has registered yet could be claimed by anyone who types it into the
 * register form -- and would then reach every /api/admin route, including
 * `recluster?reset=1`. Requiring a confirmed address closes that.
 */
export function isAdminUser(user: MaybeUser): boolean {
  if (!user?.email_confirmed_at) return false;
  return isAdminEmail(user.email);
}

/**
 * Cookie-authenticated admin requests must not arrive from another site.
 *
 * The admin routes accept GET and mutate data (`recluster?reset=1`, the
 * backfills). A SameSite=Lax session cookie IS sent on a top-level navigation
 * from a foreign page, so one click on a crafted link by a logged-in admin
 * would run them. `none` is allowed: that is the admin typing the URL.
 * Bearer-token callers (the crons) never reach this check.
 */
export function isAdminRequestOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site === 'same-origin' || site === 'same-site' || site === 'none') return true;
  if (site === 'cross-site') return false;
  // No fetch metadata (old client): fall back to origin/referer host.
  const host = request.headers.get('host');
  for (const h of [request.headers.get('origin'), request.headers.get('referer')]) {
    if (!h) continue;
    try {
      if (new URL(h).host === host) return true;
    } catch {
      /* ignore malformed header */
    }
  }
  return false;
}

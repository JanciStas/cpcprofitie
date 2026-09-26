'use server';

// Email/password auth server actions backed by @supabase/ssr.
// Returns { error: string } on failure so client forms can render Slovak messages.
//
// NOTE: in Supabase Dashboard → Authentication → Providers → Email,
// disable "Confirm email" so users can log in immediately after register.
// Otherwise enable it and update the post-register UX to show a "check your inbox" state.

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from './server';
import { safeNextPath } from './redirect';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Throttle credential attempts per client.
 *
 * Supabase has its own per-IP limit, but these calls reach it from Vercel's
 * server IPs, not the visitor's, so every user shares one bucket: an attacker
 * could stuff credentials limited only by it, and by exhausting it lock
 * everyone else out of logging in.
 */
async function throttled(scope: string, email: string, limit: number, windowMs: number) {
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? 'unknown';
  const byIp = await rateLimit({ key: `auth:${scope}:ip:${ip}`, limit: limit * 3, windowMs });
  if (!byIp.allowed) return true;
  if (!email) return false;
  const byEmail = await rateLimit({
    key: `auth:${scope}:email:${email.toLowerCase()}`,
    limit,
    windowMs,
  });
  return !byEmail.allowed;
}

type ActionResult = { error: string } | void;

function translate(message: string): string {
  // Log raw error server-side so it appears in `pnpm dev` / Vercel logs.
  console.warn('[auth] supabase error:', message);
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Nesprávny e-mail alebo heslo.';
  if (m.includes('email not confirmed')) return 'E-mail ešte nie je potvrdený. Skontrolujte si schránku.';
  if (m.includes('user already registered')) return 'Účet s týmto e-mailom už existuje.';
  if (m.includes('password should be at least')) return 'Heslo musí mať aspoň 6 znakov.';
  if (m.includes('rate limit')) return 'Príliš veľa pokusov. Skúste o chvíľu znova.';
  if (m.includes('email')) return 'Neplatný e-mail.';
  return 'Niečo sa pokazilo. Skúste to znova.';
}

async function getSupabaseOr503() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  return supabase;
}

export async function loginAction(_: ActionResult, formData: FormData): Promise<ActionResult> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const next = safeNextPath(String(formData.get('next') ?? ''));

  if (!email || !password) return { error: 'Vyplňte e-mail aj heslo.' };
  if (await throttled('login', email, 10, 15 * 60_000)) {
    return { error: 'Príliš veľa pokusov. Skúste o chvíľu znova.' };
  }

  const supabase = await getSupabaseOr503();
  if (!supabase) return { error: 'Prihlásenie je dočasne nedostupné.' };

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: translate(error.message) };

  redirect(next);
}

export async function registerAction(_: ActionResult, formData: FormData): Promise<ActionResult> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');

  if (!email || !password) return { error: 'Vyplňte e-mail aj heslo.' };
  if (password.length < 6) return { error: 'Heslo musí mať aspoň 6 znakov.' };
  if (password !== confirm) return { error: 'Heslá sa nezhodujú.' };

  if (await throttled('register', '', 5, 60 * 60_000)) {
    return { error: 'Príliš veľa pokusov. Skúste o chvíľu znova.' };
  }

  const supabase = await getSupabaseOr503();
  if (!supabase) return { error: 'Registrácia je dočasne nedostupná.' };

  const { error } = await supabase.auth.signUp({ email, password });
  if (error) return { error: translate(error.message) };

  redirect('/app/overview');
}

export async function requestPasswordResetAction(
  _: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) return { error: 'Zadajte svoj e-mail.' };
  // Each call sends an e-mail from our domain; unthrottled it is a way to
  // spam someone's inbox with password-reset mail.
  if (await throttled('reset', email, 3, 60 * 60_000)) {
    return { error: 'Príliš veľa pokusov. Skúste o chvíľu znova.' };
  }

  const supabase = await getSupabaseOr503();
  if (!supabase) return { error: 'Obnovenie hesla je dočasne nedostupné.' };

  const h = await headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  const redirectTo = `${proto}://${host}/auth/update-password`;

  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) return { error: translate(error.message) };

  return { error: '' };
}

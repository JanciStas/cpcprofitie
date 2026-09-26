import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/server';
import { isSameOrigin } from '@/lib/auth/csrf';
import { PLANS } from '@/lib/billing/plans';
import { getStripe } from '@/lib/stripe/server';

export const runtime = 'nodejs';

// Reject control chars (CR/LF/NUL/etc) so a malicious path can't be smuggled
// into Stripe's success_url and later weaponised if a refactor passes the
// path back through redirect()/fetch().
const SAFE_PATH = /^\/(?!\/)[^\s\x00-\x1f\x7f]*$/;

const BodySchema = z.object({
  priceId: z.string().min(8),
  successPath: z.string().regex(SAFE_PATH).default('/app/billing?status=success'),
  cancelPath: z.string().regex(SAFE_PATH).default('/app/billing?status=cancel'),
});

function isKnownPriceId(priceId: string): boolean {
  return Object.values(PLANS).some(
    (p) => p.stripePriceMonthly === priceId || p.stripePriceYearly === priceId,
  );
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const user = await getCurrentUser();
  if (!user?.email) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const stripe = getStripe();
  if (!stripe) {
    return NextResponse.json({ error: 'stripe_unavailable' }, { status: 503 });
  }

  const json = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  if (!isKnownPriceId(parsed.data.priceId)) {
    return NextResponse.json({ error: 'unknown_price_id' }, { status: 400 });
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: parsed.data.priceId, quantity: 1 }],
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: { userId: user.id },
      // The webhook reads userId off the SUBSCRIPTION, and session metadata
      // does not carry over to it. Without this every paying customer was
      // charged, the webhook logged "missing user metadata", returned 200 so
      // Stripe never retried, and the user stayed on Free.
      subscription_data: { metadata: { userId: user.id } },
      success_url: `${baseUrl}${parsed.data.successPath}`,
      cancel_url: `${baseUrl}${parsed.data.cancelPath}`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
    });
    if (!session.url) {
      return NextResponse.json({ error: 'session_url_missing' }, { status: 502 });
    }
    return NextResponse.json({ url: session.url });
  } catch (e) {
    console.error('stripe_checkout_failed', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'checkout_failed' }, { status: 502 });
  }
}

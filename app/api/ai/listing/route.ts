import { streamText } from 'ai';
import { z } from 'zod';
import { DEFAULT_MODEL } from '@/lib/ai';
import { buildSystemPrompt, buildUserPrompt } from '@/lib/ai/prompts';
import { getCurrentUser } from '@/lib/auth/server';
import { canGenerateAiListing } from '@/lib/billing/quota';
import { effectivePlan, getUserSubscription } from '@/lib/billing/subscription';
import { countAiListingsThisMonth, recordAiListing } from '@/lib/billing/usage';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 60;

const PROD = process.env.VERCEL_ENV === 'production';

const InputSchema = z.object({
  make: z.string().min(1).max(64),
  model: z.string().min(1).max(96),
  year: z.coerce.number().int().min(1980).max(new Date().getFullYear() + 1),
  mileageKm: z.coerce.number().int().min(0).max(2_000_000),
  // Bounded: these go straight into the prompt, and an unbounded string was a
  // way to make one request cost ~200k input tokens.
  fuel: z.string().max(64).optional(),
  transmission: z.string().max(64).optional(),
  bodyType: z.string().max(64).optional(),
  features: z.string().max(1000).optional(),
  priceEur: z.coerce.number().int().min(0).max(2_000_000).optional(),
  tone: z.enum(['formal', 'sales', 'short']).default('sales'),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();

  // Once the AI Gateway is wired, calling this endpoint costs us money for
  // every token. Require an authenticated user in production so anonymous
  // traffic can't burn quota. In dev we keep it open so the demo works.
  if (PROD && process.env.AI_GATEWAY_API_KEY && !user) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';
  // Per-user when authenticated, per-IP otherwise. Tighter limit for anon.
  const bucketKey = user ? `ai-listing:user:${user.id}` : `ai-listing:ip:${ip}`;
  // The monthly quota is checked before streaming but recorded only when the
  // stream finishes, so parallel requests all pass the check. A tight
  // per-minute cap bounds how far that race can overshoot.
  const limit = user ? 5 : 10;
  const verdict = await rateLimit({ key: bucketKey, limit, windowMs: 60_000 });
  if (!verdict.allowed) {
    return Response.json(
      { error: 'rate_limited', retryAfterMs: verdict.resetMs },
      {
        status: 429,
        headers: { 'retry-after': Math.ceil(verdict.resetMs / 1000).toString() },
      },
    );
  }

  let json: unknown = null;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: 'malformed_json' }, { status: 400 });
  }
  const parsed = InputSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: 'validation_failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const system = buildSystemPrompt(input.tone);
  const userPrompt = buildUserPrompt(input);

  // Without an AI Gateway key, stream a deterministic mock so the UI is
  // demoable in local-only mode.
  if (!process.env.AI_GATEWAY_API_KEY) {
    // In production a canned text dressed up as an AI result is a lie to the
    // user; say the feature is unavailable instead. The mock stays for local
    // development, where it is the whole point.
    if (PROD) {
      return Response.json(
        { error: 'ai_unavailable', message: 'AI inzeráty sú dočasne nedostupné.' },
        { status: 503 },
      );
    }
    return new Response(mockStream(input), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-cpcprofit-mode': 'mock',
      },
    });
  }

  // Live generations burn real tokens — enforce the per-plan monthly quota
  // (lib/billing/quota.ts) and log each run into ai_listings so the billing
  // page shows real usage. Mock mode above stays uncounted (costs nothing).
  if (user) {
    const [sub, usedThisMonth] = await Promise.all([
      getUserSubscription(user.id),
      countAiListingsThisMonth(user.id),
    ]);
    const quota = canGenerateAiListing(effectivePlan(sub), usedThisMonth);
    if (!quota.ok) {
      return Response.json(
        {
          error: 'quota_exceeded',
          limit: quota.limit,
          message: `Vyčerpali ste mesačný limit ${quota.limit} AI inzerátov. Limit sa obnoví začiatkom mesiaca.`,
        },
        { status: 429 },
      );
    }
  }

  try {
    const result = streamText({
      model: DEFAULT_MODEL,
      system,
      prompt: userPrompt,
      temperature: 0.7,
      onFinish: user
        ? async ({ text, usage }) => {
            await recordAiListing({
              userId: user.id,
              input,
              generatedTitle: text.split('\n')[0]?.slice(0, 200) ?? null,
              generatedBody: text,
              modelUsed: DEFAULT_MODEL,
              promptTokens: usage.inputTokens ?? null,
              completionTokens: usage.outputTokens ?? null,
            });
          }
        : undefined,
    });
    return result.toTextStreamResponse({
      headers: { 'x-cpcprofit-mode': 'live' },
    });
  } catch (e) {
    console.error('ai_listing_stream_failed', e instanceof Error ? e.message : e);
    return Response.json({ error: 'ai_unavailable' }, { status: 502 });
  }
}

type MockInput = z.infer<typeof InputSchema>;

function mockStream(input: MockInput): ReadableStream<Uint8Array> {
  const fluff = {
    formal: 'Vozidlo je v stave zodpovedajúcom roku výroby a počtu najazdených kilometrov.',
    sales: 'Pripravené na okamžité prebratie s plnou servisnou históriou.',
    short: 'Ihneď k odberu.',
  }[input.tone];

  const text =
    `${input.make} ${input.model} ${input.year}\n\n` +
    `${input.make} ${input.model} z roku ${input.year} s nájazdom ${input.mileageKm} km. ` +
    `${input.fuel ? `Palivo ${input.fuel}. ` : ''}${input.transmission ? `Prevodovka ${input.transmission}. ` : ''}` +
    `${input.features ? `Výbava: ${input.features}. ` : ''}` +
    `${fluff} ` +
    `${input.priceEur ? `Cena ${input.priceEur} €.` : ''}\n\n` +
    `(Demo režim — nakonfigurujte AI_GATEWAY_API_KEY pre živé generovanie.)`;

  const encoder = new TextEncoder();
  const tokens = text.split(/(\s+)/);
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= tokens.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(tokens[i]!));
      i++;
      await new Promise<void>((r) => setTimeout(r, 35));
    },
  });
}

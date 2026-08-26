// Re-ask the listings we already wrote off. Reads CRON_SECRET from .env.local
// (never logs it). Run with:
//   node scripts/trigger-reverify-removed.mjs --dry
//   node scripts/trigger-reverify-removed.mjs --loop=20
//
// WHY. Until 2026-08-26 the enrichment path recorded HTTP 403 -- "the source is
// blocking us" -- as removed_at, and the tombstone said only '[GONE]'. 11 473
// rows therefore carry a verdict nobody can audit. Each answer settles it:
//
//   404/410 -> tombstone becomes '[GONE:reverified]', removed_at is KEPT.
//              Today's 404 confirms the departure happened, not that it
//              happened today, so the original stamp stays as the best estimate
//              of when. The distinct marker is what lets the read side keep
//              these out of week-over-week comparisons.
//   200     -> removed_at and sold_at are cleared and the tombstone dropped.
//              The listing was never gone; it comes back into the corpus.
//
// The mass-removal guard is off in this mode: here a high share of 404 is the
// expected answer, not a symptom.
//
// Same pacing as the sweep -- one request per host per 1.2s, three hosts in
// round-robin, each run stopping on its own deadline. Loop this; never run two
// shells at once. The per-host budget is per process, and pairing parallel
// streams with a catalogue walk is what took autobazar.sk dark for four days.
import { readFileSync } from 'node:fs';

const BASE = 'https://cpcprofitie.vercel.app/api/cron/check-removed?mode=reverify';

const dry = process.argv.includes('--dry');
const loopArg = process.argv.find((a) => a.startsWith('--loop='));
const loops = loopArg ? Number(loopArg.split('=')[1]) : 1;

const env = readFileSync('.env.local', 'utf8');
const m = /^CRON_SECRET=(.+)$/m.exec(env);
if (!m) {
  console.error('CRON_SECRET not found in .env.local');
  process.exit(2);
}
const secret = m[1].trim().replace(/^["']|["']$/g, '');

let totalGone = 0;
let totalRestored = 0;

for (let i = 1; i <= loops; i++) {
  const res = await fetch(dry ? `${BASE}&dryRun=1` : BASE, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const body = await res.json().catch(() => ({}));
  if (dry) {
    console.log(`dry queued=${JSON.stringify(body.queued)} cursors=${JSON.stringify(body.cursors)}`);
    break;
  }
  const s = body.stats ?? {};
  totalGone += s.markedRemoved ?? 0;
  totalRestored += body.restored ?? 0;
  const per = Object.entries(s.bySource ?? {})
    .map(([src, v]) => `${src}:${v.checked}${v.backedOff ? ' BACKOFF' : ''}${v.wrapped ? ' wrap' : ''}`)
    .join(' ');
  console.log(
    `r${i} http=${res.status} checked=${s.checked ?? '?'} potvrdene_prec=${s.markedRemoved ?? '?'} ` +
      `vratene=${body.restored ?? '?'} err=${s.errors ?? '?'} ${per}` +
      `${body.error ? ` ERROR=${body.error}` : ''}`,
  );
  if (res.status >= 500) {
    console.error('stopping: server reported failure');
    break;
  }
  // Every source wrapped means the whole ambiguous set has been settled.
  const wrapped = Object.values(s.bySource ?? {});
  if (wrapped.length > 0 && wrapped.every((v) => v.wrapped)) {
    console.log('all sources wrapped -- nothing ambiguous left');
    break;
  }
}

if (!dry) {
  console.log(`SPOLU potvrdene_prec=${totalGone} vratene_do_korpusu=${totalRestored}`);
}

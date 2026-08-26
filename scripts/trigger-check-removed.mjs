// Drive /api/cron/check-removed. Reads CRON_SECRET from .env.local (never logs
// it). Run with:
//   node scripts/trigger-check-removed.mjs --dry
//   node scripts/trigger-check-removed.mjs            # one real run
//   node scripts/trigger-check-removed.mjs --loop=6   # six runs back to back
//
// The route paces itself at 1.2 s per HOST and stops on its own deadline, so
// looping here is safe in a way that looping the enrichment driver is not:
// this adds runs in sequence, never streams in parallel. Do not "speed it up"
// by running two shells -- the per-host budget is per process, and pairing
// parallel streams with a catalogue walk is what took autobazar.sk dark for
// four days in August.
import { readFileSync } from 'node:fs';

const BASE = 'https://cpcprofitie.vercel.app/api/cron/check-removed';

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

for (let i = 1; i <= loops; i++) {
  const url = dry ? `${BASE}?dryRun=1` : BASE;
  const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
  const body = await res.json().catch(() => ({}));
  if (dry) {
    console.log(`dry cursors=${JSON.stringify(body.cursors)} queued=${JSON.stringify(body.queued)}`);
    break;
  }
  const s = body.stats ?? {};
  const per = Object.entries(s.bySource ?? {})
    .map(([src, v]) => `${src}:${v.checked}/-${v.removed}${v.wrapped ? ' wrap' : ''}`)
    .join(' ');
  console.log(
    `r${i} http=${res.status} checked=${s.checked ?? '?'} removed=${s.markedRemoved ?? '?'} ` +
      `live=${s.stillLive ?? '?'} err=${s.errors ?? '?'} deadline=${s.hitDeadline ?? '?'} ` +
      `${per}${body.error ? ` ERROR=${body.error}` : ''}`,
  );
  if (res.status >= 500) {
    console.error('stopping: server reported failure');
    break;
  }
}

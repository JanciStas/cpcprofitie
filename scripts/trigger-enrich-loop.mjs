// Drive /api/cron/enrich-source in a loop until done. Reads CRON_SECRET
// from .env.local (never logs it). Run with:
//   node scripts/trigger-enrich-loop.mjs <source>
//   node scripts/trigger-enrich-loop.mjs autobazar.sk --mode=null-price
//   node scripts/trigger-enrich-loop.mjs autobazar.eu --mode=null-model
//     ^ backfill: re-fetch detail pages for active listings still missing a
//       price / model. Loops until the whole set is walked once; re-run to
//       retry any rows whose detail yielded nothing.

// PARTITIONS MULTIPLY THE REQUEST RATE. lib/scraping/enrich.ts paces itself at
// >= 1.5 s per fetch (or the robots Crawl-delay, whichever is larger), but that
// budget is per process: running --modulo=3 sends three times as fast, and the
// server side does not know the other two exist.
//
// On 2026-08-21 that cost us the source. A full 1 001-page catalogue walk plus
// ~2.5 hours of three-stream detail enrichment against autobazar.sk in one
// evening ended with the site refusing connections from the Vercel egress IP
// entirely -- list pages and detail pages alike, while bazos.sk and
// autobazar.eu from the same IP were unaffected. Nothing was lost (the page
// cursor does not advance on an errored page) but the source went dark.
//
// Use one stream unless there is a reason not to, and never pair a full
// catalogue walk with a mass enrichment of the same host on the same day.
import { readFileSync } from 'node:fs';

const source = process.argv[2];
if (!source) {
  console.error(
    'usage: node scripts/trigger-enrich-loop.mjs <source> [--mode=null-price] [--partition=K --modulo=N]',
  );
  process.exit(2);
}
// Optional partitioning so N shells split the backlog by id % modulo.
let partition;
let modulo;
let mode;
for (const arg of process.argv.slice(3)) {
  const p = /^--partition=(\d+)$/.exec(arg);
  const m = /^--modulo=(\d+)$/.exec(arg);
  const md = /^--mode=(.+)$/.exec(arg);
  if (p) partition = Number(p[1]);
  if (m) modulo = Number(m[1]);
  if (md) {
    // Reject typos loudly instead of silently falling through to a full
    // unenriched pass the operator didn't ask for.
    if (!['null-price', 'null-model', 'null-locality', 'null-country', 'null-vin', 'stale-price', 'null-description', 'unenriched', 'unenriched-newest'].includes(md[1])) {
      console.error(`invalid --mode='${md[1]}' (expected null-price|null-model|null-locality|null-country|null-vin|stale-price|null-description|unenriched|unenriched-newest)`);
      process.exit(2);
    }
    mode = md[1];
  }
}
// Cursor threaded across invocations for null-price mode (server returns it).
let afterId;
const partitionTag = partition != null && modulo != null ? `[${partition}/${modulo}]` : '';

const env = readFileSync('.env.local', 'utf8');
const m = /^CRON_SECRET=(.+)$/m.exec(env);
if (!m) {
  console.error('CRON_SECRET not found in .env.local');
  process.exit(1);
}
const secret = m[1].replace(/^["']|["']$/g, '');

const ENDPOINT = 'https://cpcprofitie.vercel.app/api/cron/enrich-source';
const FETCH_TIMEOUT_MS = 280_000;
const startedAt = Date.now();
let runningTotal = 0;
let invocation = 0;
let consecutiveErrors = 0;

async function callOnce() {
  invocation++;
  const ts = new Date().toISOString().slice(11, 19);
  const start = Date.now();
  const ac = new AbortController();
  const abortTimer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source,
        ...(partition != null && modulo != null ? { partition, modulo } : {}),
        ...(mode ? { mode } : {}),
        ...(afterId != null ? { afterId } : {}),
      }),
      signal: ac.signal,
    });
    const text = await res.text();
    const ms = Date.now() - start;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.log(`[${source}${partitionTag}][${ts}] inv ${invocation}: bad response after ${ms}ms — ${text.slice(0, 200)}`);
      return { done: false, fatal: text.includes('TIMEOUT') ? false : true };
    }
    if (parsed.error) {
      console.log(`[${source}${partitionTag}][${ts}] inv ${invocation}: ERROR ${parsed.error} ${parsed.message ?? ''}`);
      return { done: false, fatal: parsed.error === 'unauthorized' };
    }
    runningTotal += parsed.totalDetails ?? 0;
    // Advance the null-price cursor so the next invocation continues the walk.
    if (parsed.nextCursor != null) afterId = String(parsed.nextCursor);
    consecutiveErrors = 0;
    const totalSecs = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(
      `[${source}${partitionTag}][${ts}] inv ${invocation}: ${parsed.totalFetched}/${parsed.batches * 10} fetched, ${parsed.totalDetails} saved, ${parsed.totalSkipped ?? 0} skipped, ${parsed.totalErrors} errors, ${(ms / 1000).toFixed(0)}s. ` +
        `done=${parsed.done}. running total=${runningTotal} in ${totalSecs}s`,
    );
    return { done: parsed.done === true, fatal: false };
  } catch (e) {
    consecutiveErrors++;
    console.log(`[${source}${partitionTag}][${ts}] inv ${invocation}: FETCH ERROR ${e.message} (consec=${consecutiveErrors})`);
    return { done: false, fatal: consecutiveErrors >= 10 };
  } finally {
    clearTimeout(abortTimer);
  }
}

while (true) {
  const result = await callOnce();
  if (result.done) {
    console.log(`[${source}${partitionTag}] ALL DONE after ${invocation} invocations, total ${runningTotal} enriched`);
    break;
  }
  if (result.fatal) {
    console.log(`[${source}${partitionTag}] FATAL — ${consecutiveErrors} consecutive errors, aborting`);
    process.exit(1);
  }
  // Exponential backoff on consecutive errors: 3s → 10s → 30s → 60s → 60s ...
  const breath =
    consecutiveErrors === 0 ? 3000
    : consecutiveErrors === 1 ? 10_000
    : consecutiveErrors === 2 ? 30_000
    : 60_000;
  await new Promise((r) => setTimeout(r, breath));
}

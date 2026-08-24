// Cursor persistence for cron-driven backfills.
//
// Every backfill under app/api/admin walks the table by id and returns
// `nextCursor` for its caller to hand back. A script in a loop can do that; a
// cron cannot, because it fires the same URL each time. Without somewhere to
// keep the cursor, each run repeats the first batch for ever — which is why
// none of those tools was ever scheduled, and why the corpus only ever filled
// in when someone sat and drove it.
//
// Rows that stay NULL after a successful pass are the reason a cursor is
// needed at all rather than just "select where field is null": a title that
// resolves to no model, or an advert with no year printed anywhere, sits at
// the head of the set permanently and would be re-fetched on every run.

import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';

export type JobCursor = {
  afterId: bigint | null;
  passNo: number;
};

/** Where this job got to, or a fresh start if it has never run. */
export async function loadJobCursor(jobKey: string): Promise<JobCursor> {
  const rows = (await getDb().execute(sql`
    SELECT after_id, pass_no FROM job_cursors WHERE job_key = ${jobKey}
  `)) as unknown as Array<{ after_id: string | number | bigint | null; pass_no: number }>;
  const row = rows[0];
  if (!row) return { afterId: null, passNo: 1 };
  return {
    afterId: row.after_id == null ? null : BigInt(row.after_id),
    passNo: Number(row.pass_no),
  };
}

/**
 * Advance the cursor, or wrap it back to the top.
 *
 * `nextCursor === null` means the walk reached the end of the set. The cursor
 * resets and the pass counter increments, so the next run starts over: without
 * that, a backfill would run exactly once and never look at anything added
 * afterwards.
 */
export async function saveJobCursor(jobKey: string, nextCursor: string | null): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO job_cursors (job_key, after_id, pass_no, updated_at)
    VALUES (
      ${jobKey},
      ${nextCursor},
      1,
      now()
    )
    ON CONFLICT (job_key) DO UPDATE SET
      after_id = ${nextCursor},
      pass_no = job_cursors.pass_no + ${nextCursor == null ? 1 : 0},
      updated_at = now()
  `);
}

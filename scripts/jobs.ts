// Runs a scheduled job (build step 12). For system cron or any scheduler. Examples:
//   npm run jobs -- daily
//   npm run jobs -- month_end --date 2026-11-30
// Exits with 1 if the job failed, so the scheduler can alert. See docs/manuals/admin-guide.md.
import { parseArgs } from 'node:util';
import { isJob, isRunDate, JOBS, runJob } from '../src/lib/jobs/run';
import { createMailer } from '../src/lib/platform/smtp-email';
import { closePool } from '../src/lib/server-db';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { date: { type: 'string' } } });
const job = positionals[0];
if (!isJob(job) || (values.date !== undefined && !isRunDate(values.date))) {
  console.error(`Usage: npm run jobs -- <${JOBS.join('|')}> [--date YYYY-MM-DD]`);
  process.exit(1);
}

try {
  const result = await runJob(job, { date: values.date, triggeredBy: 'schedule', mailer: createMailer() });
  console.log(`${result.job} for ${result.runFor}: ${result.status} ${JSON.stringify(result.counts)}${result.error ? ` (${result.error})` : ''}`);
  // Partly failed (some emails not sent, decision 92) also exits 1, so the scheduler alerts.
  process.exitCode = result.status === 'failed' || result.status === 'partial' ? 1 : 0;
} finally {
  await closePool();
}

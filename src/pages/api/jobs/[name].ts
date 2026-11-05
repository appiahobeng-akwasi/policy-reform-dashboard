// POST /api/jobs/<nightly|daily|weekly|month_end>, for a hosting platform's scheduler
// (decision 50). Needs "Authorization: Bearer <JOBS_SECRET>"; closed when JOBS_SECRET is unset.
// Optional ?date=YYYY-MM-DD runs for another day (for catching up).
import type { APIRoute } from 'astro';
import { env } from '../../../lib/env';
import { isJob, isRunDate, runJob } from '../../../lib/jobs/run';
import { secretMatches } from '../../../lib/jobs/secret';
import { createMailer } from '../../../lib/platform/smtp-email';

export const POST: APIRoute = async ({ params, request, url }) => {
  if (!secretMatches(request.headers.get('authorization'), env.jobsSecret)) return new Response(null, { status: 404 });
  const name = params['name'];
  const date = url.searchParams.get('date') ?? undefined;
  if (!isJob(name) || (date !== undefined && !isRunDate(date))) return new Response(null, { status: 404 });
  const result = await runJob(name, { date, triggeredBy: 'schedule', mailer: createMailer() });
  return Response.json(result, { status: result.status === 'failed' ? 500 : 200 });
};

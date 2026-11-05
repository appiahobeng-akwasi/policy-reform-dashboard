// Load test (decision 67): many signed-in people at once on the six views, My items, Notices and
// Reviews, against a running server. Each person opens a page, reads for a while (--think,
// default 10 seconds), then opens the next. Passes when 95% of requests are served within 1.5
// seconds and under 1% fail. Examples:
//   npm run load-test                                  50 people for 60 seconds on APP_BASE_URL
//   npm run load-test -- --think 0                     stress: no reading time, to find capacity
//   npm run load-test -- --connections 50 --duration 15 --url http://localhost:4321
// It adds load-test accounts (load-<run>-<n>@example.com) to the database DATABASE_URL points to,
// and signs them in through the provider's admin key, so run it on a test system, never on live.
// Slow networks are tested page by page in tests/e2e/views.spec.ts (Slow 3G, decision 41).
import { createClient } from '@supabase/supabase-js';
import autocannon from 'autocannon';
import { parseArgs } from 'node:util';
import { connect, databaseUrl, loadEnv } from './lib/db';
import { addUser } from './lib/users';

loadEnv();
const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    connections: { type: 'string', default: '50' },
    duration: { type: 'string', default: '60' },
    accounts: { type: 'string', default: '10' },
    think: { type: 'string', default: '10' },
  },
});
const base = (values.url ?? process.env['APP_BASE_URL'] ?? 'http://localhost:4321').replace(/\/+$/, '');
const connections = Number(values.connections);
const duration = Number(values.duration);
const think = Number(values.think);
// 50 people each opening a page every 10 seconds is 5 requests a second in all.
const overallRate = think > 0 ? Math.max(1, Math.round(connections / think)) : undefined;
const TARGET = { p95Ms: 1500, errorRate: 0.01 };
const PATHS = ['/executive', '/portfolio', '/pathway', '/risks', '/merl', '/governance', '/my-items', '/notices', '/reviews'];

const secret = process.env['SUPABASE_SECRET_KEY'];
const supabaseUrl = process.env['SUPABASE_URL'];
if (!secret || !supabaseUrl) throw new Error('The load test signs in through the provider admin key: set SUPABASE_URL and SUPABASE_SECRET_KEY.');
const admin = createClient(supabaseUrl, secret, { auth: { persistSession: false, autoRefreshToken: false } });

/** Adds a viewer account and signs it in the way a person would, returning its session cookies. */
async function session(email: string): Promise<string> {
  const db = await connect(databaseUrl());
  try {
    await addUser(db, { email, name: `Load test ${email.split('@')[0]}`, role: 'viewer_internal' });
  } finally {
    await db.end();
  }
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error || !data.properties?.hashed_token) throw new Error(`No sign-in link for ${email}: ${error?.message}`);
  const response = await fetch(`${base}/auth/confirm`, {
    method: 'POST',
    // As a browser sends with its own form (Astro's origin check).
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ token_hash: data.properties.hashed_token }),
    redirect: 'manual',
  });
  const cookies = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (!cookies.includes('auth-token')) throw new Error(`Sign-in failed for ${email} (status ${response.status}).`);
  return cookies;
}

const run = Date.now().toString(36);
const sessions: string[] = [];
for (let i = 0; i < Number(values.accounts); i += 1) sessions.push(await session(`load-${run}-${i}@example.com`));
console.log(
  `Signed in ${sessions.length} accounts. Running ${connections} people for ${duration} s on ${base}, ${overallRate ? `${overallRate} requests a second in all (${think} s reading time each)` : 'with no reading time (stress)'} ...`,
);

const times: number[] = [];
let next = 0;
const result = await new Promise<autocannon.Result>((resolve, reject) => {
  const instance = autocannon(
    {
      url: base,
      connections,
      duration,
      ...(overallRate ? { overallRate } : {}),
      requests: [
        {
          setupRequest: (request) => {
            const n = next++;
            return { ...request, method: 'GET', path: PATHS[n % PATHS.length]!, headers: { cookie: sessions[n % sessions.length]!, 'accept-language': n % 2 ? 'fr' : 'en' } };
          },
        },
      ],
    },
    (error, done) => (error ? reject(error) : resolve(done)),
  );
  instance.on('response', (_client: unknown, _status: number, _bytes: number, responseTime: number) => times.push(responseTime));
});

times.sort((a, b) => a - b);
const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
const total = result.requests.total;
const failed = result.non2xx + result.errors + result.timeouts;
const errorRate = total ? failed / total : 1;
console.log(
  JSON.stringify(
    { requests: total, perSecond: Math.round(result.requests.average), p50Ms: p(0.5), p95Ms: p(0.95), p99Ms: p(0.99), failed, errorRate: Number(errorRate.toFixed(4)) },
    null,
    2,
  ),
);
const ok = p(0.95) <= TARGET.p95Ms && errorRate < TARGET.errorRate && total > 0;
console.log(ok ? `Passed: 95% within ${TARGET.p95Ms} ms, under ${TARGET.errorRate * 100}% failed.` : `Failed the target: 95% within ${TARGET.p95Ms} ms and under ${TARGET.errorRate * 100}% failed.`);
process.exit(ok ? 0 : 1);

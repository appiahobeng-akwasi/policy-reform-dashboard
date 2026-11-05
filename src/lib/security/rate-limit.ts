// Rate limits on sign-in, uploads, sending updates and the scheduler address (spec 01 section 11,
// docs/04 section 6, decision 63). Counted in the database, so limits hold across several copies
// of the app. Keys are hashed before they are stored.
import { env } from '../env';
import { inServerTransaction } from '../server-db';

export type Limit = { bucket: string; limit: number; windowSeconds: number };

export const LIMITS = {
  /** Sign-in links asked for, per email address. */
  signInEmail: { bucket: 'sign_in_email', limit: 5, windowSeconds: 900 },
  /** Sign-in links asked for, per network address. */
  signInIp: { bucket: 'sign_in_ip', limit: 20, windowSeconds: 900 },
  /** Opening a sign-in link or entering an authenticator code, per network address. */
  verify: { bucket: 'verify', limit: 20, windowSeconds: 900 },
  /** Starting an upload or checking an uploaded file, per person. */
  upload: { bucket: 'upload', limit: 60, windowSeconds: 3600 },
  /** Sending an update or a bulk upload's fixes, per person. */
  submit: { bucket: 'submit', limit: 120, windowSeconds: 3600 },
  /** Calls to the scheduler address, per network address. */
  jobs: { bucket: 'jobs', limit: 30, windowSeconds: 3600 },
} as const satisfies Record<string, Limit>;

type Rule = { method: string; path: RegExp; limit: Limit; by: 'user' | 'ip' };

/** Which requests count against which limit. Reading pages never does. */
export const RULES: Rule[] = [
  { method: 'POST', path: /^\/sign-in\/?$/, limit: LIMITS.signInIp, by: 'ip' },
  { method: 'POST', path: /^\/auth\/(confirm|mfa)\/?$/, limit: LIMITS.verify, by: 'ip' },
  { method: 'POST', path: /^\/api\/uploads\/?$/, limit: LIMITS.upload, by: 'user' },
  { method: 'POST', path: /^\/api\/(evidence|bulk)\/receive\/?$/, limit: LIMITS.upload, by: 'user' },
  { method: 'POST', path: /^\/uploads\/new\/?$/, limit: LIMITS.upload, by: 'user' },
  { method: 'POST', path: /^\/items\/[a-z_]+\/[^/]+\/?$/, limit: LIMITS.submit, by: 'user' },
  { method: 'POST', path: /^\/uploads\/[0-9a-f-]{36}\/?$/, limit: LIMITS.submit, by: 'user' },
  { method: 'POST', path: /^\/api\/jobs\/[a-z_]+\/?$/, limit: LIMITS.jobs, by: 'ip' },
];

export function ruleFor(method: string, path: string): Rule | null {
  return RULES.find((r) => r.method === method && r.path.test(path)) ?? null;
}

/**
 * The client's network address. Behind a proxy or load balancer set TRUST_PROXY=true so the
 * address it reports (X-Forwarded-For, first entry) is used instead of the proxy's own.
 */
export function clientIp(request: Request, socketAddress: string | undefined): string {
  if (env.trustProxy) {
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  return socketAddress ?? 'unknown';
}

/** Counts one try; true if it is within the limit. */
export async function allow(limit: Limit, key: string): Promise<boolean> {
  return inServerTransaction(async (db) => {
    const { rows } = await db.query<{ ok: boolean }>('select hit_rate_limit($1, $2, $3, $4) as ok', [limit.bucket, key, limit.limit, limit.windowSeconds]);
    return rows[0]?.ok !== false;
  });
}

// Pure helpers for npm run hosted:setup (decision 88). No network, no files: tested in
// tests/unit/hosted-setup.test.ts.

/** Supabase's connection pooler hosts for a region. Projects sit on one of these. */
export function poolerHosts(region: string): string[] {
  return [`aws-0-${region}.pooler.supabase.com`, `aws-1-${region}.pooler.supabase.com`];
}

/**
 * A Supabase pooler address. Port 5432 is the session pooler (admin commands, backups),
 * 6543 the transaction pooler (the app on Vercel). Always encrypted; verified (decision 91)
 * means the certificate and host name are checked against DATABASE_SSL_CA.
 */
export function poolerUrl(opts: { ref: string; password: string; host: string; port: 5432 | 6543; verified?: boolean }): string {
  if (!/^[a-z0-9]+$/.test(opts.ref)) throw new Error('A project ref has only lower-case letters and digits.');
  const mode = opts.verified === false ? 'no-verify' : 'verify-full';
  return `postgresql://postgres.${opts.ref}:${encodeURIComponent(opts.password)}@${opts.host}:${opts.port}/postgres?sslmode=${mode}`;
}

/** The same address with a different TLS mode (an address saved before decision 91 becomes verified). */
export function withSslMode(url: string, mode: 'verify-full' | 'no-verify'): string {
  const parsed = new URL(url);
  parsed.searchParams.set('sslmode', mode);
  return parsed.toString();
}

/** The same address on the transaction pooler (port 6543). */
export function transactionPoolerUrl(sessionUrl: string): string {
  const url = new URL(sessionUrl);
  url.port = '6543';
  return url.toString();
}

type CliKey = { name?: string; type?: string; api_key?: string };

const unmasked = (key: string) => /^[A-Za-z0-9_.-]+$/.test(key);

/**
 * The project's admin key from `supabase projects api-keys -o json`: the "default" secret key
 * (sb_secret_...) when the tool shows it in full, otherwise the legacy service_role key, which
 * the admin API accepts the same way. The tool masks new secret keys with dots.
 */
export function pickSecretKey(cliJson: string): string | null {
  let keys: CliKey[];
  try {
    keys = JSON.parse(cliJson) as CliKey[];
  } catch {
    return null;
  }
  if (!Array.isArray(keys)) return null;
  const usable = keys.filter((k): k is CliKey & { api_key: string } => typeof k.api_key === 'string' && unmasked(k.api_key));
  const secret = usable.filter((k) => k.type === 'secret' && k.api_key.startsWith('sb_secret_'));
  const chosen = secret.find((k) => k.name === 'default') ?? secret[0] ?? usable.find((k) => k.name === 'service_role' && k.api_key.startsWith('eyJ'));
  return chosen?.api_key ?? null;
}

/** A pasted value without the spaces and line breaks that copying often adds. */
export function cleanPasted(value: string): string {
  return value.replace(/[\r\n]+/g, '').trim();
}

/**
 * Sets KEY=value lines in an env file, keeping comments and order; keys not yet there are
 * added at the end. Values must be one line.
 */
export function updateEnvFile(text: string, updates: Record<string, string>): string {
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Not an environment variable name: ${key}`);
    if (/[\r\n]/.test(value)) throw new Error(`${key} must be on one line.`);
  }
  const seen = new Set<string>();
  const lines = text.split('\n').map((line) => {
    const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (key && key in updates) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  const missing = Object.keys(updates).filter((k) => !seen.has(k));
  if (missing.length > 0) {
    if (lines.at(-1) === '') lines.pop();
    lines.push(...missing.map((k) => `${k}=${updates[k]}`), '');
  }
  return lines.join('\n');
}

/** KEY=value pairs of an env file (comments and blank lines skipped). */
export function readEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

/** Secrets the app on Vercel needs, from the hosted env file. The app uses the transaction pooler. */
export function vercelSecrets(env: Record<string, string>): [string, string][] {
  return [
    ['DATABASE_URL', transactionPoolerUrl(need(env, 'DATABASE_URL'))],
    ['DATABASE_SSL_CA', need(env, 'DATABASE_SSL_CA')],
    ['SUPABASE_SECRET_KEY', need(env, 'SUPABASE_SECRET_KEY')],
    ['S3_ACCESS_KEY_ID', need(env, 'S3_ACCESS_KEY_ID')],
    ['S3_SECRET_ACCESS_KEY', need(env, 'S3_SECRET_ACCESS_KEY')],
    ['JOBS_SECRET', need(env, 'JOBS_SECRET')],
  ];
}

/** Secrets the GitHub Actions workflows need (scheduled jobs and the weekly backup). */
export function githubSecrets(env: Record<string, string>): [string, string][] {
  return [
    ['JOBS_SECRET', need(env, 'JOBS_SECRET')],
    ['BACKUP_DATABASE_URL', need(env, 'DATABASE_URL')],
    ['DATABASE_SSL_CA', need(env, 'DATABASE_SSL_CA')],
    ['S3_ENDPOINT', need(env, 'S3_ENDPOINT')],
    ['S3_REGION', need(env, 'S3_REGION')],
    ['S3_ACCESS_KEY_ID', need(env, 'S3_ACCESS_KEY_ID')],
    ['S3_SECRET_ACCESS_KEY', need(env, 'S3_SECRET_ACCESS_KEY')],
    ['BACKUP_PASSPHRASE', need(env, 'BACKUP_PASSPHRASE')],
  ];
}

function need(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is empty in .env.hosted.`);
  return value;
}

/** Where this copy is hosted, from .env.hosted, so no project names live in the code (decision 95). */
export type HostingTarget = { projectRef: string; region: string; vercelProject: string; vercelScope: string; vercelTeamId: string; adminEmail: string };

export function hostingTarget(env: Record<string, string>): HostingTarget {
  const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(env['SUPABASE_URL'] ?? '')?.[1];
  const missing = ['VERCEL_PROJECT', 'VERCEL_SCOPE', 'VERCEL_TEAM_ID', 'ADMIN_EMAIL', 'S3_REGION'].filter((k) => !env[k]);
  if (!ref) missing.unshift('SUPABASE_URL (https://<project-ref>.supabase.co)');
  if (missing.length > 0) throw new Error(`Set these in .env.hosted first: ${missing.join(', ')}.`);
  if (!/^team_[A-Za-z0-9]+$/.test(env['VERCEL_TEAM_ID']!)) throw new Error('VERCEL_TEAM_ID starts with team_ (Vercel > Settings > General > Team ID).');
  return {
    projectRef: ref!,
    region: env['S3_REGION']!,
    vercelProject: env['VERCEL_PROJECT']!,
    vercelScope: env['VERCEL_SCOPE']!,
    vercelTeamId: env['VERCEL_TEAM_ID']!,
    adminEmail: env['ADMIN_EMAIL']!,
  };
}

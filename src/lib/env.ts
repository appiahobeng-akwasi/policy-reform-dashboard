// Server configuration. Hosting is not decided, so everything host-specific comes from
// environment variables (see .env.example). A local .env file is read if there is one;
// ENV_FILE names another (for example .env.hosted for admin commands against the hosted
// database), and must exist. Variables already set in the environment always win.
if (process.env.ENV_FILE) {
  process.loadEnvFile(process.env.ENV_FILE);
} else {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: use the environment as it is.
  }
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return value;
}

export const env = {
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  /** Root certificate the database's certificate must chain to (PEM or base64 PEM, decision 91). */
  /** Who holds the copyright in the open-source licence (decision 97). Adopters set their own. */
  get copyrightHolder(): string {
    return optional('COPYRIGHT_HOLDER') ?? 'Green Growth Programme';
  },

  /** Where the source code is published (decision 97). */
  get sourceCodeUrl(): string {
    const url = optional('SOURCE_CODE_URL') ?? 'https://github.com/appiahobeng-akwasi/policy-reform-dashboard';
    return /^https:\/\//.test(url) ? url : 'https://github.com/appiahobeng-akwasi/policy-reform-dashboard';
  },

  /** The commit this copy was built from, when the host says (Vercel does), for the About page. */
  get gitCommit(): string | undefined {
    const sha = optional('VERCEL_GIT_COMMIT_SHA') ?? optional('GIT_COMMIT');
    return sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 7) : undefined;
  },

  /** DEMO_DATA=true: every page says the data is fictional (the public copy's demo seed, decision 95). */
  get demoData(): boolean {
    return optional('DEMO_DATA') === 'true';
  },

  get databaseSslCa(): string | undefined {
    return optional('DATABASE_SSL_CA');
  },
  /** Database connections each copy of the app keeps open (default 10). */
  get databasePoolSize(): number {
    const n = Number(optional('DATABASE_POOL_SIZE') ?? '10');
    return Number.isInteger(n) && n > 0 ? n : 10;
  },
  get appBaseUrl(): string {
    return required('APP_BASE_URL').replace(/\/+$/, '');
  },
  get supabaseUrl(): string {
    return required('SUPABASE_URL');
  },
  get supabasePublishableKey(): string {
    return required('SUPABASE_PUBLISHABLE_KEY');
  },
  /**
   * Secret key for the sign-in provider's admin API (server only). Needed to see who has set up an
   * authenticator app and to reset one. Without it those two things are unavailable; nothing else is.
   */
  get supabaseSecretKey(): string | undefined {
    return optional('SUPABASE_SECRET_KEY');
  },
  /**
   * Outgoing email by SMTP (Mailpit locally; a transactional provider when hosted). Without
   * SMTP_HOST, reminders and digests are notices in the app only.
   */
  get smtp(): { host: string; port: number; secure: boolean; user: string | undefined; pass: string | undefined; from: string } | null {
    const host = optional('SMTP_HOST');
    if (!host) return null;
    return {
      host,
      port: Number(optional('SMTP_PORT') ?? '587'),
      secure: optional('SMTP_SECURE') === 'true',
      user: optional('SMTP_USER'),
      pass: optional('SMTP_PASS'),
      from: optional('EMAIL_FROM') ?? 'Pillar 1 dashboard <no-reply@localhost>',
    };
  },
  /** Behind a proxy or load balancer: trust its X-Forwarded-For for the client's address. */
  get trustProxy(): boolean {
    return optional('TRUST_PROXY') === 'true';
  },
  /** Network addresses not counted by the per-address limits (a health checker, the test server). */
  get rateLimitIpExempt(): string[] {
    return (optional('RATE_LIMIT_IP_EXEMPT') ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
  },
  /** Test-only pages (for example one that fails on purpose). Never set this on a real server. */
  get testRoutes(): boolean {
    return optional('ENABLE_TEST_ROUTES') === 'true';
  },
  /** Shared secret a scheduler sends to POST /api/jobs/<name>. Without it, that address is closed. */
  get jobsSecret(): string | undefined {
    return optional('JOBS_SECRET');
  },
  /** S3-compatible file storage (Supabase Storage today; MinIO or AWS later). */
  get s3(): { endpoint: string; publicEndpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string; forcePathStyle: boolean } {
    const endpoint = required('S3_ENDPOINT');
    return {
      endpoint,
      publicEndpoint: optional('S3_PUBLIC_ENDPOINT') ?? endpoint,
      region: required('S3_REGION'),
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
      bucket: optional('S3_BUCKET') ?? 'dashboard-files',
      forcePathStyle: optional('S3_FORCE_PATH_STYLE') !== 'false',
    };
  },
};

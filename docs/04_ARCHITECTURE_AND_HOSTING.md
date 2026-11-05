# Architecture and hosting

## 1. Principle

Design the database first, in plain PostgreSQL, so the choice of back-end tool and host can be made later without redoing work. Agreed approach (3 Nov): build the tool now, and finalise hosting with the team over time. The 6 Nov meeting starts that conversation; it is not a decision point for the build. The kickoff deck says the same: stay technology-agnostic at PoC stage and confirm platform, hosting, licensing, security and ownership during production design.

Six layers (from the kickoff deck) and what fills each:

| Layer | Prototype (by 13 Nov) | Production options |
|---|---|---|
| 1 Data capture | Web form, bulk upload, on-behalf entry | Same; WhatsApp/email intake in Phase 2 |
| 2 System of record | PostgreSQL (schema in this kit) | Same schema on managed or self-hosted Postgres |
| 3 Workflow | Submissions, gate, approvals, reminders, escalations | Same; or Directus Flows / NocoDB automations if Route 1 is chosen |
| 4 Evidence | S3-compatible object storage | Same (Supabase Storage, MinIO, or any S3) |
| 5 Analytics | Six views in the custom front end | Same; optionally Metabase for ad hoc analysis |
| 6 Users | Google or magic-link sign-in, allowlist, roles, RLS | Same |

## 2. Stack for the prototype

| Concern | Choice | Why |
|---|---|---|
| Database, auth, storage | Supabase (Postgres 15+, Auth, Storage) | the product owner knows it from an earlier project; open source (Apache 2.0) and self-hostable later; Google sign-in works with personal Gmail |
| Front end | Astro with server rendering + small React islands, TypeScript | Same pattern as an earlier project; ships little JavaScript; good on weak connections |
| Styling | Plain CSS with design tokens | No runtime CSS framework weight |
| Charts | Hand-written SVG components (heatmap, stage track, bars, sparklines) | No heavy charting bundle |
| Excel parsing | SheetJS (xlsx) on the server; never trust client-side parsing for the gate | Template is .xlsx |
| Validation | One shared rule engine in TypeScript that reads `dq_rules.v1.json`, used by the form (client hints) and the server (authoritative) | Same rules on every route |
| i18n | Message catalogue (fr.json, en.json); EN | FR switch per user, saved to profile | Required from day one |
| Email | Transactional provider (Resend, or SMTP relay) | Reminders, digests, approvals |
| Scheduled jobs | Cron (platform cron in prototype; system cron or pg_cron in production) | Reminders 07:00 daily, digest Monday 07:00 Kinshasa (06:00 UTC), snapshots month end |
| Tests | Vitest (unit, rules), Playwright (journeys), pgTAP or SQL tests for RLS | an earlier project had no tests; this one must |
| CI | GitHub Actions: typecheck, lint, tests, migration dry run on a fresh Postgres | |

Local development uses Colima (free, open source) to run Docker containers on the Mac, not Docker Desktop. Docker Desktop needs a paid licence for an organisation of Delivery Partner A's size. The Supabase CLI runs the local database stack inside Colima. Start command: `colima start --cpu 2 --memory 4 --vm-type vz --mount-type virtiofs`. CI does not use Colima or Supabase; it runs the migrations on plain Postgres.

Hosting for the build and prototype: a Supabase project plus a Node host (Vercel or similar) behind sign-in, treated as temporary. Production hosting is finalised with the team later; the app must move without code changes. Use realistic sample data unless the project lead confirms real RA1 data may sit on a cloud host for the demo (source data is marked Restricted).

## 3. Production routes to discuss with the team

| Route | What it is | For | Against |
|---|---|---|---|
| 1. Ready-made back end | Directus or NocoDB on this Postgres schema (+ Metabase) | Forms, roles, Google sign-in, revision history, file storage out of the box; low code to hand over | Views less tailored; the gate and scoring still need custom code (Directus Flows or an extension) |
| 2. Custom app | This kit's app as the production system | Best fit to the operating model, lightest on bandwidth | the product owner becomes the only maintainer; handover risk after March |
| 3. Mix (recommended) | Custom front end for the six views, inbox, form and gate; standard Postgres + Storage; Directus or Supabase Studio as the admin console for the Secretariat | Tailored where it matters, standard tools for administration | Two tools to document |

Directus and NocoDB can read an existing Postgres schema, so Route 1 or 3 can be adopted later without migrating data.

## 4. Hosting questions to settle with the team (start 6 Nov, finalise before production go-live)

1. Who maintains the system after March 2027: a named person or team, with what skills?
2. Who pays for hosting, domain and email, and on whose account (Delivery Partner A, Delivery Partner B or the programme)?
3. Does Funding Partner or Delivery Partner B set data handling rules for this data (classification, location, retention)?
4. Does the DRC Digital Code (Ordonnance-loi 23/010, March 2023) data-localisation duty apply to this data? Its implementing rules have not been issued. Legal view needed before choosing an in-country host.
5. How many users, on what devices and connections? How many government users?
6. Will Funding Partner accept a non-Microsoft stack as the TOR's "or equivalent"? Get it in writing.
7. Is a custom domain needed (for example dashboard.ggp-drc.org) and who controls DNS?

## 5. Hosting options

| Option | Notes |
|---|---|
| Managed (Supabase cloud + app host) | Fastest; region choice (EU or South Africa); monthly cost; data outside DRC |
| Self-hosted on a cloud VM (Docker: Postgres, Supabase or Directus, MinIO, app) | Full control; needs an admin; backups are our job |
| In-country data centre | Satisfies a localisation duty if it applies; check power, connectivity, support contracts and backup arrangements |
| Hybrid | Database and files in country, app served from a CDN | Only if localisation applies to data but not to the application layer |

Whichever is chosen: daily database backups kept 30 days, weekly export of database and evidence to a second location under programme control, restore tested before go-live, documented in D6 and D9.

## 6. Security checklist (lessons from an earlier project built in)

- PKCE auth flow, not implicit (an earlier project put session tokens in the URL fragment).
- All schema in versioned migrations; nothing created by hand in a hosted console (an earlier project had schema that lived only in the hosted database).
- Automated tests from day one (an earlier project had none).
- Strict Content Security Policy: no inline scripts; images only from own origin and storage.
- MFA for admins; allowlist sign-in for everyone.
- Service-role key only in server code; never in the browser bundle.
- Rate limits on auth, upload and submit endpoints.
- Uploads: check magic bytes, not just extension; reject macro-enabled files; size caps; strip formulas; store originals privately.
- Evidence served by signed URLs with short expiry.
- Central error logging and an alert on failed cron jobs.
- DMARC at quarantine or reject for the sending domain.

## 6a. What the chosen host must provide

Built into the app (build step 14): security headers and content policy, rate limits, error logging with alerts, backup and restore scripts, a health check (`/healthz`) and a load test. The host must still provide:

- **HTTPS** with a valid certificate, redirecting plain HTTP. HSTS is sent once the app is served over HTTPS.
- **Daily database backups kept 30 days**, plus a weekly `npm run backup` copied to a second place under programme control (spec 01 section 11), and a restore tested before go-live (SOP: backup and restore).
- **A scheduler** for the four jobs (admin guide section 12).
- **An email provider** with SPF, DKIM and DMARC at quarantine or reject for the sending domain (open question 28).
- **Log collection** of the app's output (one JSON line per error), and an uptime check on `/healthz`.
- Behind a proxy or load balancer: `TRUST_PROXY=true`. Size `DATABASE_POOL_SIZE` (default 10 per copy) to the database's connection limit.
- The PostgreSQL client tools (`pg_dump`, `pg_restore`) at the database's version, for backups.

## 6b. Trial host: Vercel and Supabase (decision 88)

This host is for trying the tool. It is not the production decision (section 4). Everything here
is set by environment variables, so the same code still runs on any Node host.

**What runs where**

| Part | Where | Notes |
|---|---|---|
| App | Vercel Pro, functions in London (`lhr1`, `vercel.json`) | Built with `ASTRO_ADAPTER=vercel`; Vercel sets `VERCEL=1`, which picks the same adapter. `@astrojs/vercel` is a dev dependency: it only runs at build time and bundles what the functions need |
| Database, sign-in, files | Supabase project `ggp-pillar1-dashboard`, London (`eu-west-2`), free plan | Free plan: no daily backups, pauses after 7 days without use |
| Scheduled jobs | GitHub Actions, `.github/workflows/scheduled-jobs.yml` | Calls `POST /api/jobs/<name>` with `JOBS_SECRET` |
| Backups | GitHub Actions, `.github/workflows/backup.yml`, Sundays | Encrypted with `BACKUP_PASSPHRASE`, kept 30 days |
| Email | Resend over SMTP, from a programme domain | Sign-in links (Supabase Auth) and reminders (the app) |

**Connections.** The app on Vercel uses Supabase's transaction pooler (port 6543) with
`DATABASE_POOL_SIZE=3`: each function copy opens only a few connections, and the app only uses
settings local to a transaction, which the pooler supports. Admin commands from a laptop and the
backup use the session pooler (port 5432). The direct address needs IPv6, which GitHub's runners do
not have.

**Known limits on Vercel.** The rate limits and the resumable upload lock live in each function
copy's memory, so they are weaker when Vercel runs several copies at once. That is acceptable for a
small trial. For production, use one long-running server or a shared store (see `src/lib/evidence/tus.ts`).
Uploads go in 1 MB pieces, under Vercel's 4.5 MB limit for one request.

**Setting it up, in order**

1. **Supabase project and secrets.** The project was created on 4 Nov 2026. Then run `npm run hosted:setup` yourself in a terminal. It:
   - fetches the admin key with the Supabase command-line tool (the new secret key if the tool shows it in full, otherwise the legacy service_role key, which works the same way);
   - asks for the database password (Database > Settings > Reset database password) and one storage key (Storage > S3 > Access keys > New access key), hiding what you type and checking each value at once;
   - writes `.env.hosted` (git-ignored) with the session pooler address and a new backup passphrase;
   - sends the secrets to Vercel (Sensitive, Production; the app gets the transaction pooler) and to GitHub (Actions secrets), with your signed-in Vercel and GitHub tools. It never prints a secret, and running it again replaces what it set.

   Keep the database password and the `BACKUP_PASSPHRASE` line in the password manager. Connections are encrypted and verified (decision 91): the address uses `sslmode=verify-full`, and `DATABASE_SSL_CA` holds Supabase's public root certificate (`db/platform/supabase-root-2021.crt`, SHA-256 `80:70:25:AD:…:CA:FA`), so the app and the backup check the certificate and the host name. `hosted:setup` sets both on Vercel and GitHub. Running it again asks for nothing when the saved password and storage key still work.
2. **Schema and seed.** From the project folder:
   - `ENV_FILE=.env.hosted npm run db:migrate` applies every migration and the seed, plus the platform grants and the sign-in hook function. `db:reset` refuses remote databases on purpose.
   - `ENV_FILE=.env.hosted npm run storage:setup` creates the `dashboard-files` bucket.
3. **Supabase Auth settings.**
   - Authentication > Hooks: turn on "Before user created" as a Postgres function, `public.hook_before_user_created`. Without it, anyone could make an account (the app would still refuse them, but the account would exist).
   - URL Configuration: set Site URL to the app's address and add `<address>/auth/confirm` to the redirect URLs.
   - Emails (SMTP and both templates) and the hourly email limit: run `npm run hosted:email` yourself (decision 93). It asks for the domain, a Resend API key and a Supabase access token (Account > Access tokens, one day expiry; delete it after), hides what you type, and sets Supabase Auth to send through Resend with the app's sign-in email (`src/lib/email/sign-in-template.ts`) for "Magic link" and "Confirm sign up", one-hour links and 100 emails an hour. It reads the settings back to check them, saves the app's email settings in `.env.hosted` and on Vercel, and sends a test email. Redeploy the app afterwards so it picks up the new settings. The hosted default links sign in as soon as they are opened, so email scanners use them up; never go back to them.
   - Integrations > Data API > Settings: untick every exposed schema and save, which turns the Data API off. The app talks to Postgres directly and never uses it; left on, its public address can reach the app's database functions (done 4 Nov 2026).
   - Sign In / Providers > Email: leave email sign-in on and keep the link lifetime at one hour or less.
   - Multi-factor: TOTP on (the default).
4. **Resend and the domain.** The sending domain is `example.org`, bought in Vercel so its DNS is on Vercel (decision 93). Sign up to Resend and create a "Full access" API key named "dashboard set-up". `npm run hosted:email` then adds the domain to Resend (region eu-west-1, click and open tracking off), writes Resend's SPF and DKIM records and DMARC at quarantine (section 6a) into Vercel DNS, waits until Resend shows the domain as verified, and makes a sending-only key limited to the domain, which is the only key it stores. Delete the "dashboard set-up" key in Resend afterwards. If verification takes longer than 15 minutes, run the command again later: it picks up where it stopped. Without a domain, Resend's test sender `onboarding@resend.dev` works but only delivers to the Resend account's own email.
5. **Vercel project** from the GitHub repository, framework Astro, region London (created 4 Nov 2026; `hosted:setup` sends the secrets). Environment variables for Production, as in `.env.example`:
   - Not secret: `APP_BASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE=true`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `EMAIL_FROM`, `DATABASE_POOL_SIZE=3`, `TRUST_PROXY=true`.
   - Secret (mark Sensitive): `DATABASE_URL` (transaction pooler, port 6543), `SUPABASE_SECRET_KEY`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `SMTP_PASS`, `JOBS_SECRET`.
   - Never set `ENABLE_TEST_ROUTES` or `RATE_LIMIT_IP_EXEMPT` here.
6. **GitHub repository settings** > Secrets and variables > Actions (`hosted:setup` sets these):
   - Variable `APP_BASE_URL`.
   - Secrets `JOBS_SECRET` (same value as Vercel), `BACKUP_DATABASE_URL` (session pooler), `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `BACKUP_PASSPHRASE`. Keep the passphrase in the password manager too: without it no backup can be read.
7. **People.** `ENV_FILE=.env.hosted npm run users:add -- --email … --name "…" --role …`, then sign in. Admins set up an authenticator app at first sign-in. If an email does not arrive, `ENV_FILE=.env.hosted npm run users:link -- --email …` makes a one-time link to pass on privately.
8. **Check.** Open `/healthz`, sign in, send one update, approve it as someone else, and run each job once from the Actions tab ("Run workflow"). Then run the backup workflow once and test a restore on a local database (SOP: backup and restore).

**Moving off this host.** Back up with `npm run backup`, restore into the new Postgres with
`npm run restore`, copy the files with the same backup, set the same environment variables, and
build with the default Node adapter (`npm run build`, then `node dist/server/entry.mjs`).

## 7. Low-bandwidth design rules

- Server-render every view; hydrate only interactive islands.
- First load ≤ 300 KB JS compressed; each view ≤ 150 KB data on first paint; paginate at 50 rows.
- Compress images in the browser before upload; resumable uploads above 2 MB.
- Cache lookups and labels in the browser; send only changed fields on update.
- Test every release on a throttled "Slow 3G" profile and on a low-end Android phone.

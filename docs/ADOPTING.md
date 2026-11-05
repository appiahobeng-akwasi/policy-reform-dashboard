# Adopting the dashboard for your programme

This guide is for an IT team that wants to run the dashboard for its own reform programme. It covers trying it, putting in your own data, adapting it, and hosting it. The [README](../README.md) has the short version.

## 1. Try it with the demo data

Follow "Try it on your computer" in the README. The demo data is fictional: three reforms (RA1 to RA3) with workstreams, milestones, risks, decisions, indicators and evidence, dated mid-2026, so most of it shows as overdue or stale. That is on purpose: it lets you see escalations, reminders and red ratings at work. While `DEMO_DATA=true`, every page says the data is fictional.

Make yourself `super_admin`, then sign in a second person as a contributor (`npm run users:add -- --email … --role contributor`) to try the full loop: the contributor sends an update, the quality check runs, and you approve it. Nobody can approve their own update.

## 2. Roles

| Role | Can |
|---|---|
| `super_admin` | Everything, including direct writes (logged). Two-step sign-in required |
| `programme_admin` | Manage people, approve any update, run jobs, see data quality for everyone. Two-step sign-in required |
| `reform_lead` | Approve updates for their own reforms where allowed |
| `merl_officer` | Approve indicator values; see all results data |
| `contributor` | Send updates on items they own |
| `viewer_internal` | Read the programme's data |
| `viewer_counterpart` | Read their own reform only, without risks or decisions; see public evidence and external evidence linked to their reform |

Row-level security in the database enforces these. `tests/db` has a test for each role.

## 3. Put in your own data

1. **Start from an empty programme.** Replace `db/seed/0100_demo_seed.sql` with your own seed file, or keep only its first part (lookup values, pathway stages, rule set, reporting periods) and delete the rest. The demo file shows every table and column in use.
2. **Reforms** are the top of the chain and come from the seed: one row per reform in `reforms` (ID such as `RA1`, English and French names, objective, lead institutions, current stage). Add their pathway stages in `reform_stages`.
3. **Workstreams, deliverables, activities, milestones, risks, decisions, indicator values and evidence** can then come in through the bulk upload (Excel template in `templates/`, page **Bulk upload**), and go through the same quality check and approval as any other change.
4. **People:** `npm run users:add` for people who sign in, `npm run people:add` for owners who do not.
5. **Indicators:** add your results framework to `indicators` (codes, names, units, baselines, Year 1 targets). Life-of-programme targets only show once `target_lop_confirmed` is true.
6. Run `npm run db:reset` locally to check it all loads, then set `DEMO_DATA=false` (or remove it).

Never put real programme data in a public repository. Keep your seed in a private repository, or load it straight into your database with `npm run db:migrate`.

## 4. Adapt it

- **Names and wording:** every word on screen is in `src/i18n/en.json` and `src/i18n/fr.json`, including the app name (`app.name`, `app.programme`). A test fails if any text is hard-coded in a page.
- **Quality rules:** `rules/dq_rules.v1.json` holds every check, its weight and its message in both languages. The pass mark is 80. If you change the rules, raise the version and keep a passing and a failing fixture for each rule in `tests/dq/fixtures`.
- **Time zone:** `DISPLAY_TIME_ZONE` in `src/i18n/index.ts` (Africa/Kinshasa by default). Times are stored in UTC.
- **Schedules:** reminders, escalations, the weekly digest and the month-end snapshot are called on `POST /api/jobs/<name>` with `JOBS_SECRET`. Any scheduler works; `.github/workflows/scheduled-jobs.yml` is one example.
- **Look and feel:** tokens in `src/styles/tokens.css`; the rules in `docs/08_DESIGN_SYSTEM.md`.

## 5. Host it

The app is a Node server and a PostgreSQL database, plus somewhere to keep files (S3-compatible) and send email (SMTP). Everything is set by environment variables: `.env.example` lists them all.

**Any host.** Build with `npm run build`, start with `npm start` (`node ./dist/server/entry.mjs`) behind HTTPS, set the variables, and run `npm run db:migrate` against your database. Sign-in uses Supabase Auth through `src/lib/platform/supabase-auth.ts`. To use another provider, replace that adapter; the rest of the app does not call Supabase directly.

**Vercel and Supabase (the route used for the first trial).** `docs/04_ARCHITECTURE_AND_HOSTING.md` section 6b gives the steps. In short:

1. Create a Supabase project and a Vercel project. Put the non-secret names in `.env.hosted` (git-ignored): `SUPABASE_URL`, `S3_REGION`, `VERCEL_PROJECT`, `VERCEL_SCOPE`, `VERCEL_TEAM_ID`, `ADMIN_EMAIL`, `APP_BASE_URL`.
2. Run `npm run hosted:setup`. It asks for the database password and a storage key, checks them, and sends the secrets to Vercel and GitHub without printing them.
3. `ENV_FILE=.env.hosted npm run db:migrate`, then `ENV_FILE=.env.hosted npm run storage:setup`.
4. Buy or choose an email domain, then run `npm run hosted:email`. It sets up Resend for sign-in emails, reminders and digests, including the DNS records when the domain is on Vercel.
5. Turn on the "Before user created" hook in Supabase Auth (`public.hook_before_user_created`), so only people you added can make an account.

**Backups.** `npm run backup` and `npm run restore` move the database and files between hosts; `.github/workflows/backup.yml` runs an encrypted weekly backup. Test a restore before you rely on it (`docs/manuals/sops/backup-and-restore.md`).

## 6. Before real use

- Replace the demo data and set `DEMO_DATA=false`.
- Use your own email domain with SPF, DKIM and DMARC.
- Give administrators two-step sign-in (the app requires it).
- Run the whole test suite against your copy, and repeat a sign-in, an update, an approval and each scheduled job once on the hosted site.
- Read [SECURITY.md](../SECURITY.md).

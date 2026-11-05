# Administrator and developer guide

Status: draft, updated with every feature. Prototype stage.

## 1. Local set-up on a Mac

You need: Homebrew, Node 26 (the version in `.nvmrc`; 22.23.4 is the oldest that works), Git, Colima, the Docker command-line tools and the Supabase CLI.

```bash
brew install colima docker supabase/tap/supabase
colima start --cpu 2 --memory 4 --vm-type vz --mount-type virtiofs
```

Colima runs Docker containers without Docker Desktop (which needs a paid licence for an organisation of Delivery Partner A's size). After the Mac restarts, start it again with `colima start`.

Then, in the project folder:

```bash
npm ci
cp .env.example .env
supabase start
npm run db:reset
```

Run `supabase status` and copy into `.env`: the "Publishable key" into `SUPABASE_PUBLISHABLE_KEY`, and the "S3 Access Key" and "S3 Secret Key" into `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Create the file storage bucket once with `npm run storage:setup`. Then add yourself (see section 5) and start the app:

```bash
npm run users:add -- --email you@example.org --name "Your Name" --role super_admin
npm run dev
```

The app runs at http://localhost:4321. Sign-in emails do not leave your Mac: open the local mail catcher at http://localhost:54324 to find them. Supabase Studio (a database browser) runs at http://localhost:54323.

`npm run db:reset` deletes every account, so add yourself again after a reset. After changing `supabase/config.toml` or the email template, restart Supabase with `supabase stop` then `supabase start`.

## 2. Database commands

| Command | What it does | Where it may run |
|---|---|---|
| `npm run db:reset` | Deletes everything, applies `db/migrations` in order, then loads `db/seed` | Only a database on this machine. It refuses any other host. |
| `npm run db:migrate` | Applies only the migration and seed files not applied yet. Safe to run again. | Any database, including a hosted one |

Both read `DATABASE_URL` from `.env` (or the environment).

Rules:

- Every schema change is a new numbered file in `db/migrations` (0004, 0005 ...). Never edit a file that has been applied: `db:migrate` stops with an error if an applied file has changed.
- Never change the schema in a hosted console.
- Do not use `supabase db reset`. It reads `supabase/migrations`, which this project does not use, and would leave an empty database.
- The runner records what it applied in `app_meta.schema_files` (file name, checksum, time).
- On Supabase, the runner also applies `db/platform/supabase_grants.sql`, which lets the API roles reach the tables. Row-level security still decides what each user sees. Signed-out visitors get no table access.
- On Supabase, it also applies `db/platform/supabase_auth_hook.sql`, which stops Supabase creating a sign-in identity for any email not on the list.

## 3. Moving the database to another host

The schema is plain Postgres 15+. To point the app at a hosted or self-hosted database:

1. Create an empty Postgres 15+ database on the new host.
2. Set `DATABASE_URL` to its connection string (in `.env` locally, or in the host's environment settings).
3. Run `npm run db:migrate`. It applies all migrations and the seed.
4. To move existing data, run `npm run backup` against the old host and `npm run restore -- <folder> --to <new database>` instead of step 3 (section 14, and the SOP [Backup and restore](sops/backup-and-restore.md)).

No code changes are needed. Supabase-specific code (sign-in, and file storage later) stays in `src/lib/platform/`.

Known gap before a move away from Supabase: the app reads data as the database role `authenticated`, which Supabase creates. Another host needs that role created first. A script for this will be added with the hosting decision.

## 4. Signing in

People sign in with a one-time link sent to their email address. Any email service works (Gmail, Yahoo, Outlook, a work address). There are no passwords.

- **Only listed people can sign in.** The list is the `app_users` table. Someone not on it sees the same "check your email" message as everyone else, so the form cannot be used to find out who is registered, but no email is sent. Supabase itself also refuses to create a sign-in for an unlisted email (the sign-in hook).
- **The link works once and expires after one hour.** It can be opened on a different device from the one that asked for it (decision 18). Opening it shows a "Sign in" button; the link is only used when the button is pressed, so email security scanners cannot use it up first.
- **Asking twice too quickly is refused.** Supabase allows one link per address per second locally and per 60 seconds on a hosted project. The person sees "Wait a minute, then try again".
- **MFA for admins.** super_admin and programme_admin must set up an authenticator app on first sign-in and enter a code at every sign-in. Until they do, the database gives them no access at all (decision 17), not just a blocked page. A super administrator resets a lost app on the users page (section 5).
- **Language.** The EN | FR choice of a signed-in person is saved to their profile and follows them to any device.
- **Sessions** are kept in secure cookies that page scripts cannot read. The browser never talks to Supabase directly.

The sign-in email is sent by Supabase in both languages. Its text comes from `src/i18n`; after changing an `email.*` string, run `npm run build:email-templates` and restart Supabase.

For a hosted Supabase project, set its Site URL to the app's address, add `<app address>/auth/confirm` to the allowed redirect URLs, upload `supabase/templates/sign_in.html` as the magic link and confirm signup templates, enable TOTP MFA, point the "before user created" hook at `public.hook_before_user_created`, and set up an email provider (SMTP). Supabase's built-in email service is for testing only.

## 5. Users and access

**Users** in the menu (programme and super administrators). Use the SOP [Onboarding a new user](sops/onboarding-a-new-user.md).

- **Add a user:** name, email, role, language and reforms. For each reform, tick *Works on*, and *Approves for* if a reform lead approves for it. Administrators cover every reform without ticking. The person can sign in as soon as you save.
- **Edit:** open the person from the list. Changing the email unlinks the old address, so only the new one can sign in.
- **Turn off an account** when someone leaves. They are signed out at their next click. Nothing they did is deleted, and you can turn the account on again.
- **Reset an authenticator app** (super administrators only): when an administrator loses their phone. They set up a new app at their next sign-in.
- **Changes to this account** at the bottom lists every change, who made it and when (from the audit log).

The database refuses, whatever page or tool is used (decision 42):

| Code | Refusal |
|---|---|
| U01 | Changing your own role or turning off your own account. Ask another administrator. |
| U02 | A programme administrator creating or changing a super administrator. |
| U03 | Setting the sign-in link by hand. It is set when the person signs in. |
| U04 | Deleting an account. Turn it off instead. |
| U05 | Leaving no active super administrator. Add another one first. |

The authenticator column and resets need `SUPABASE_SECRET_KEY` on the server (see `.env.example`). Without it, they show as unknown and resets are refused with a clear message.

The command line still works, for example to add the first super administrator on a new database:

```bash
npm run users:add -- --email name@gmail.com --name "Full Name" --role reform_lead --scope RA1:approve
```

**People without accounts** (owners who will not sign in, decision 24): **Users**, then **People without accounts**. Add them with a name, and an email if bulk uploads will name them. Untick *Active* when they leave: they stay on the items they owned. **Give access** on their page turns them into a user. `npm run people:add` does the same from the command line. Every open item needs an owner who is a person (rule B08), so add the owners named in the seed before the data refresh.

## 6. Approvals

Nobody changes programme data directly. Every change is a submission: it passes the data quality gate, then a second person approves it. The database enforces this, not the screens. The approval screens come in a later build step; the rules below already apply.

Who may approve:

| Role | May approve |
|---|---|
| programme_admin | Any reform, and programme-wide items |
| reform_lead | Their own reforms, where their scope has "can approve" ticked. Not indicator values |
| merl_officer | Indicator values, for every reform |
| super_admin | Only through break-glass (see below) |
| contributor, viewers | Nothing |

Rules applied at the moment of approval:

- Nobody approves their own submission, or one entered on their behalf.
- The submission must have passed the gate on the current rule set. If its content changes after the gate, it must pass the gate again.
- The checks that depend on live data run again: everything referred to still exists (B03), the submitter may still change that reform (B11), and the reporting period is still open (B12).
- All rows are saved, or none are.
- Each change is written to the audit log with who made it, who it was entered for and which submission it came from. The approval itself is logged too.
- The submitter gets a notice when their submission is approved or returned.

To return a submission, the approver must say what needs fixing. Submitters can withdraw anything not yet approved.

**Break-glass.** In an emergency the super_admin can approve any submission, including their own, by choosing break-glass and giving a reason. The reason is stored on the submission and in the audit log. Review every break-glass approval at the next weekly review.

**Who sees submissions.** Submitters see their own. Reform leads see those touching their reforms. MERL officers see those with indicator values. Admins see all. Per-user data quality figures are visible only to that user and to admins.

**The approvals screen** (`/approvals`) lists what each person may approve, worked out by the same database rules as approval (`approvable_submissions()`, `can_i_approve()`). Approvers see the quality score and points of the submission they are approving (decision 34) and can open its files through 60-second links (decision 35); per-user data quality stays private. "Nothing changed" confirmations can be approved together (decision 37). When a submission passes the gate, everyone who may approve it gets an in-app notice (decision 36).

**For developers.** The payload format and error codes are described at the top of `db/migrations/0005_approval_workflow.sql`. Functions whose comment starts with `internal:` cannot be called by signed-in users.

## 7. The data quality gate

Every submission goes through the gate before anyone can approve it (docs/03). The rules, their weights, messages and the pass mark live in `rules/dq_rules.v1.json` and, once loaded, in the `dq_rulesets` table. The checks themselves are in `src/lib/gate/` (one function per rule ID); the server run is in `src/lib/gate-server/`.

- **Pass** = no file or blocking failures, and a quality score of at least the threshold (80). The score is rounded half up to one decimal, so 79.95 passes.
- **Order:** file rules (uploads only; any failure stops the run), auto-fixes (spaces, letter case), blocking rules, scored rules.
- **Every attempt is logged,** pass or reject: `dq_runs` (score, threshold, rule set version, attempt number, link to the previous attempt) and `dq_findings` (each gap, in English and French). A rejected submission keeps its rows so the person can fix and retry.
- **Auto-fixes are saved** into the submission, so approval applies exactly what passed.
- **The database rule set is authoritative.** The server refuses to run if the current rule set has a rule the code does not implement, or the other way round.
- **Staleness (Q23)** does not count at the gate (decision 20).
- **Owners (B08):** open items need an owner who is a person in the system. Add owners on the users page; people who will not sign in go under **People without accounts** (section 5).

Changing a rule means a new rule set version, tested and approved by the Project Lead (docs/03 section 9). Every rule has a passing and a failing example in `tests/dq/fixtures/`; add or update them with any change. A new rule also needs a short name in `src/i18n/en.json` and `fr.json` under `rules` (a test checks this).

### The data quality page

**Data quality** in the menu (programme and super administrators). Filter by period (Kinshasa months), how the update was sent, reform and person.

The page opens with four tiles (average score against the pass mark, first-time pass rate, attempts and rejected attempts), then the trend beside **Needs attention**, which shows training suggested and the three checks that fail most. The detail sits in five tabs: **By person**, **Checks**, **Time to fix**, **Stale items** and **All attempts** (decision 90). The filters keep the tab you are on.

- **Trend:** the last 12 months of average score (solid) and first-time pass rate (dashed).
- **Training suggested:** people whose last five submissions passed first time less than 60% of the time, with the three checks that failed most. **Send a training notice** puts an in-app notice in their Notices naming those checks (once a day at most). Talk to them as well: the notice is a prompt, not the training.
- **By person:** listed by name, never ranked. Do not share these figures beyond the person and the administrators (docs/03 section 8).
- **Checks that fail most, by month:** with an example message. A check marked *Review this check first* failed for more than 30% of the people who sent updates that month: fix the wording, the template or the form before training anyone, and log the decision.
- **Time to fix:** updates checked, fixed after a rejection, not passed yet, the median hours to fix and the average attempts.
- **Stale items by owner:** open items not confirmed for over 30 days. The owner's name opens the Pathway view filtered to them.
- **All attempts:** every gate attempt, passed or not. Bulk upload attempts open the upload.

Everyone else sees only their own figures, under **My data quality**.

## 8. Evidence files

Evidence files are kept in S3-compatible storage: Supabase Storage today, any S3 store (MinIO, AWS) later, by changing the `S3_*` settings only. The bucket is private.

- Files arrive by resumable upload (the tus protocol at `/api/uploads`) as `incoming-…` objects. The server then checks each one: its type from its own bytes, no macros, at most 10 MB. It stores the checked file as `evidence/{year}/{sha256}.{ext}` (decision 25) and records it in `evidence_uploads`. Duplicate files are caught by their fingerprint.
- A file becomes an evidence item only when the update it came with is approved.
- Files open through signed links that expire after 60 seconds, issued only to people whose row-level security lets them see that evidence.
- `S3_PUBLIC_ENDPOINT` is the address browsers use for those links, if it differs from the address the server uses.
- Uploads never attached or approved are left as `incoming-…` objects; a scheduled clean-up comes in build step 12.
- **Hosting note:** with more than one app server, resumable uploads need a shared lock and cache (for example Redis). One server is fine for the prototype.

## 9. Bulk upload

- Every uploaded file is kept, unchanged, in private storage as `uploads/{year}/{sha256}.{ext}`, and recorded in `upload_batches` (file name, fingerprint, size, template version, sheets, uploader, reported_by emails). Every attempt is logged, including files that fail the file rules.
- Files are opened safely: a workbook is inspected before it is unpacked, and refused if it would unpack to more than 50 MB or 1,000 parts. Formulas are noted, never calculated. At most 2,001 rows per sheet are read.
- Excel is read with SheetJS 0.20.3, installed from cdn.sheetjs.com and pinned by checksum (decision 26). To upgrade, install the new version from the same place and run every test.
- Mapping from template columns to the database is in `src/lib/bulk/map.ts`; a test fails if a template column has no mapping. Indicator values are matched on indicator, reform and period; new ones are stored as Monthly values.
- The template and its manifest change together with the rule set (docs/03 section 9). The current template is served from the upload page.

## 10. Entering for someone else

- Only programme admins (and super_admin) can enter updates for someone else (decision 30). The database enforces this: other roles cannot create on-behalf submissions, and approval refuses per-row reporters in their uploads.
- Each on-behalf entry records the person, how and when it was received, an optional note and an optional file showing the instruction (decisions 31 and 32). The audit log records the person for every change.
- In bulk uploads by the Secretariat, each row's reported_by_email becomes that row's person (decision 33): the audit log, the scope check (B11) and four-eyes all work per row.
- The person is sent a notice (`entered_on_behalf`) when the entry passes the gate.
- Items show "Last updated …, entered by A for B" from the audit log, through `item_last_update()`, for internal users only.
- An item's Activity tab (sent, approved, returned, by whom, with the approver's note) comes from `item_activity()` (migration 0020). It returns rows only to the item's owner, the leads of its reform and administrators (decision 81); the tests in `tests/db/activity.test.ts` check each role.

## 11. Views and sample data

- All six views (Executive, Portfolio, Pathway, Risks, MERL, Governance) read the same tables and database views (`v_reform_summary`, `v_delivery_flags`, `v_readiness`) through row-level security, so numbers match everywhere. They are rendered on the server with no page JavaScript; an automated test checks each loads within 8 seconds and under 150 KB on a phone over Slow 3G (decision 41).
- The readiness score on Portfolio comes from `readiness_score_v1()` (migration 0017), the proposed method, labelled as not yet agreed (decision 58). When the project lead agrees a method, change the function in a new migration and the label in the language files.
- Risks, MERL and Governance are for internal users only; counterparts see Portfolio's stages for their reforms (decision 59).
- **Admin** in the menu opens a hub with Data quality, Users and access, People without accounts and Scheduled jobs (decision 60).
- The quality trend (`quality_trend()`) is an average across everyone, never per person.
- **Sample RA1 structure (decision 39).** If the real RA1 structure is not available for a demo:

  ```bash
  npm run sample:load
  ```

  loads two sample workstreams with deliverables, activities and milestones, owned by three sample people, all flagged `is_sample` and shown as "Sample" on every screen. It refuses to run if any of its IDs is already used. Remove it, and everything linked to it, before loading the real structure:

  ```bash
  npm run sample:remove
  ```

## 12. Scheduled jobs and email

Four jobs keep reminders, escalations and snapshots going (spec 01 section 10, decisions 47 to 52). **Jobs** in the menu shows when each last ran, what it did and any failure, with **Run now**.

| Job | When (Kinshasa) | What it does |
|---|---|---|
| `nightly` | Every night, 02:00 | Stale reminders (over 30 days, then weekly); flags pathway stages that have not moved for two monthly reviews (60 days while none is recorded); resolves escalations whose item is done or re-planned |
| `daily` | Every day, 07:00 | Due in 3 days; escalations at 1, 7 and 14 days overdue (the owner and one step up hear at each step); risk reviews overdue; the follow-up list of reminders for owners without an account; then one email per person |
| `weekly` | Mondays, 07:00 | A summary for each owner (their open items, overdue and stale first) and for admins (each reform, new escalations, updates waiting, training suggested) |
| `month_end` | The 1st, 01:00 | Freezes one snapshot per reform for the month just ended. Never overwritten |

Running a job twice in a day sends nothing twice, and two copies never run together. A failed run keeps nothing it did and records the error.

If some emails could not be sent, the run ends as **Partial**: everything else it did is kept, the Jobs page says how many emails failed, and the command and the GitHub run end in failure so someone looks. The daily job tries each failed email again on the next two days, up to three attempts in all, and the Jobs page counts the retries. An email that was sent is never sent again (decision 92).

**Starting them on a server**, either way (hosting is not decided, so both work anywhere):

1. System cron, with the times in UTC:

   ```
   0 1 * * *  cd /srv/dashboard && npm run jobs -- nightly
   0 6 * * *  cd /srv/dashboard && npm run jobs -- daily
   0 6 * * 1  cd /srv/dashboard && npm run jobs -- weekly
   0 0 1 * *  cd /srv/dashboard && npm run jobs -- month_end
   ```

   The command exits with 1 if the job failed or was partial, so cron can alert.
2. A hosting platform's scheduler: `POST /api/jobs/<nightly|daily|weekly|month_end>` with the header `Authorization: Bearer <JOBS_SECRET>`. It answers 500 on failure. Without `JOBS_SECRET` set, the address is closed.
3. On the hosted trial (decision 88), GitHub Actions does this for you: the **Scheduled jobs** workflow calls the address at the times above. To run one by hand or catch up a day, open the repository's **Actions** tab, choose **Scheduled jobs**, then **Run workflow**. A failed run turns red and GitHub emails the repository owner. GitHub may start a run up to about 30 minutes late.

To catch up a missed day: `npm run jobs -- daily --date 2026-11-03`, or `?date=2026-11-03` on the address.

**Email.** Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `EMAIL_FROM` (see `.env.example`). Locally these point at Mailpit, which catches every email at http://127.0.0.1:54324; nothing is really sent. On the hosted trial the provider is Resend, sending as `dashboard@example.org` (decision 93), set by `npm run hosted:email` together with the sign-in emails. If emails stop, check the domain still shows as verified in Resend and that its DNS records are still on Vercel (Domains > example.org), then run the command again. Without `SMTP_HOST`, everything appears in Notices only and the Jobs page says email is off. Each person can turn off the daily email under **My account**.

Owners without an account cannot read notices, so their reminders go on the Secretariat's daily follow-up list (decision 49). If a job fails, follow the SOP [When a scheduled job fails](sops/when-a-scheduled-job-fails.md).

## 13. Review packs

**Reviews** in the menu. A pack is what the Secretariat gives the monthly Pillar 1 review or the Quarterly Strategy Review (spec 01 section 8, decisions 53 to 57). Follow the SOP [Preparing a monthly review](sops/preparing-a-monthly-review.md).

- **Prepare:** choose the review and its date, then **Prepare the pack**. The pack is built from the dashboard at that moment and saved as version 1. Preparing again (after late updates, say) saves version 2; version 1 stays as it was. Nobody can change or delete a pack.
- **The four parts:** Prepare (each reform, programme-wide milestones, data as of, data quality); Review (escalations, overdue items, risk changes, high risks, indicator movements); Decide (open decisions with their tier and follow-up, and blank rows for the meeting); Track (decisions implemented and follow-up actions).
- **Since the last review** means since the previous pack of the same type, or else one month (monthly) or three months (QSR) before the review date. The pack says which date it counted from.
- **What counts as a change:** only changes made through the app (risk scores, decisions marked implemented) and approved indicator values. The original data load never shows as a change.
- **Sharing:** **Print or save as PDF** opens an A4 layout; use the browser's Print and choose Save as PDF. **Download the file** gives one HTML file that opens offline in any browser and can be emailed. Both are in the reader's language: switch to FR first for a French copy.
- **Who sees packs:** every internal user. Government counterparts do not, because packs hold risks and decisions.
- **After the meeting:** enter the decisions taken and their follow-up actions through **Bulk upload** (the Decisions and Actions sheets). They go through the checks and approval like any other update, and the next pack tracks them.

## 14. Security and operations

- **Headers and content policy** (decision 62): every response carries them. If a page breaks after a change because the browser refused something, the browser console says "Content Security Policy"; the automated tests check the main pages for this.
- **Rate limits** (decision 63): too many tries in a short while get a "Too many tries" page in the person's language, and a line in the server log. Reading pages is never limited. Behind a proxy or load balancer set `TRUST_PROXY=true`, or everyone shares one limit.
- **Errors** (decision 64): **Admin**, then **Errors**. A person who saw "Something went wrong" can quote the reference (E-7K2Q9X); search for it. Super administrators get a notice and an email when a job fails or errors pile up, at most once an hour.
- **Health** (decision 66): `/healthz` answers `{"status":"ok"}` when the database and file storage answer, and 503 when either is down. Point the host's uptime check at it.
- **Backups** (decision 65): `npm run backup` (add `--out <folder>` for a second place) and `npm run restore -- <folder> --to <database url>`. They use `pg_dump` and `pg_restore` at the database's version; on a laptop with the local stack they use the ones inside its database container. Backups hold real data: keep them private, never in the repository. Follow the SOP [Backup and restore](sops/backup-and-restore.md).
- **Load test** (decision 67): `npm run load-test -- --url <address>` against a test system (it adds load-test accounts). It plays 50 people each opening a page every 10 seconds, and passes when 95% of requests are served within 1.5 seconds and under 1% fail. `--think 0` removes the reading time, to find how many requests a second the server can take. Run it on the chosen host before go-live.
- **Writing new access rules** (decision 68): in a policy, always write `(select is_internal())`, `(select is_admin())`, `(select my_role())` and `((select me())).user_id`, never the bare call, or Postgres repeats it for every row and pages slow down as data grows. `tests/db/rls-performance.test.ts` fails if a policy gets this wrong.
- **Settings**: `DATABASE_POOL_SIZE`, `TRUST_PROXY`, `RATE_LIMIT_IP_EXEMPT` (leave empty on a real server), and never `ENABLE_TEST_ROUTES` outside tests. See `.env.example`.

## 15. Tests

| Command | What it checks |
|---|---|
| `npm test` | Unit tests, including every data quality rule's passing and failing example (no database needed) |
| `npm run test:db` | Database tests against `DATABASE_URL`: the seed, row-level security for every role, the approval chain, the account guards and the data quality figures. Run `npm run db:reset` first. |
| `npm run typecheck` | TypeScript and Astro types (strict) |
| `npm run lint` | Code style and common mistakes |
| `npm run check:bundle` | Client JavaScript stays under 300 KB compressed. Run `npm run build` first. |
| `npm run test:e2e` | A real browser signs in, sets up MFA, switches language, updates items, keeps drafts, uploads evidence, uses the card without JavaScript, runs bulk uploads, enters updates for someone else, approves, checks the views on Slow 3G, adds and turns off users, resets an authenticator app and reads the data quality pages, runs the daily job to send a reminder email, prepares, reads, prints and downloads a review pack, checks the security headers and content policy, the error page, the sign-in limit and the health check. CI also runs a backup and restore round trip, a 15-second load test and a dependency audit. The tests build and start their own server on port 4329, so a running `npm run dev` does not interfere. Needs `supabase start`, `npm run db:reset` and `npm run storage:setup` first. The first time, run `npx playwright install chromium`. These tests change the local data, so run `npm run db:reset` before `npm run test:db` afterwards. |

GitHub Actions runs all of these on every push and pull request: the database tests on fresh Postgres 15 and 17, and the database and end-to-end tests again on a local Supabase stack.

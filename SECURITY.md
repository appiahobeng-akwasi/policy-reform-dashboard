# Security policy

Please do not report security problems in public issues.

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Say what you found, how to reproduce it, and what someone could do with it. We aim to reply within five working days and to agree a date for a fix before anything is made public.

## What is in scope

- Ways to see or change data your role should not reach (the database's row-level security is the gatekeeper).
- Ways to get a change into the shared data without the quality check and a second person's approval.
- Sign-in, session, upload and file-access problems.
- Secrets, keys or personal data in this repository.

## If you run your own copy

- Keep every key in environment variables or your host's secret store, never in the repository. `.env` and `.env.*` are ignored by git.
- Turn on two-step sign-in for administrators (the app enforces it for super_admin and programme_admin).
- Use your own email domain with SPF, DKIM and DMARC, and keep link tracking off with your email provider: tracking rewrites sign-in links.
- Serve evidence files through short-lived signed links only, as the app does.
- Keep dependencies up to date (`npm audit`), and back up the database and files on a schedule (see `docs/manuals/sops/backup-and-restore.md`).

# SOP: Backup and restore

Who does it: the technical lead (or the super administrator with server access). Backups hold real programme data, including restricted evidence: keep every copy private.

## Every day (the host)

The chosen host keeps daily database backups for 30 days (spec 01 section 11). Check once a week that the latest one exists, in the host's console.

## Every week (us)

1. On a machine that can reach the database, with `DATABASE_URL` and the `S3_*` settings for the live system:

   ```bash
   npm run backup -- --out /path/to/second-place
   ```

2. Check the last line says "Backup written to ...". The folder holds `database.dump`, `files/` and `manifest.json`.
3. Copy the folder to the second place under programme control (for example the programme's own cloud drive), not the same host as the database.
4. Keep at least the last eight weekly copies. Delete older ones only once a newer one has been checked.

**On the hosted trial (decision 88).** The free Supabase plan keeps no daily backups, so the weekly one is the only copy. The **Weekly backup** workflow in GitHub Actions makes it every Sunday, encrypted, and keeps it 30 days. Each Monday:

1. Open the repository's **Actions** tab, then **Weekly backup**, and check the latest run is green.
2. Once a month, download its `backup-…` file and decrypt it on your own machine with the passphrase from the password manager:

   ```bash
   gpg --decrypt backup.tar.gz.gpg | tar -xz
   ```

3. Copy the folder to the second place under programme control, as in step 3 above.

## Before go-live, and every three months: the restore test

1. Create an empty database on a test server (never the live one).
2. Point the `S3_*` settings at an empty test bucket.
3. Restore the latest weekly backup:

   ```bash
   npm run restore -- /path/to/backup --to postgresql://user:pass@test-host:5432/restore_test
   ```

4. It must end with "Restore checked: every table has the same number of rows as the backup, and every file matches." Anything else: stop and investigate.
5. Point a test copy of the app at the restored database. Sign in (you link your account again by email), open the Executive view and one evidence file.
6. Write the date and result in the issue log. Delete the test database.

## Restoring the live system after a failure

1. Agree with the Project Lead that a restore is needed, and from which backup. Everything since that backup is lost unless the host's own backup is newer.
2. Stop the app, so nobody writes in the meantime.
3. Restore into a new, empty database, as in the restore test, with the live storage settings. Use `--keep-sign-in` only if the sign-in provider is the same one as before.
4. Point the app's `DATABASE_URL` at the restored database, start it, and check `/healthz` answers `{"status":"ok"}`.
5. Tell users what period of updates was lost and needs re-entering.

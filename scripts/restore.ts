// Restores a backup folder into an empty database, then checks it (decision 65). Examples:
//   npm run restore -- backups/2026-11-04T06-00-00Z --to postgresql://user:pass@host:5432/newdb
//   npm run restore -- <folder> --to <url> --skip-files
// Files go to the storage that S3_* points to. Sign-in links are cleared unless --keep-sign-in,
// so people link their accounts again by email at their next sign-in (needed on a new sign-in
// provider). It refuses a database that already has the app's tables unless --replace.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { applyPlatformGrants, connect, describeDatabase, loadEnv } from './lib/db';
import { pgTool, SCHEMAS, sha256, tableCounts, type Manifest } from './lib/backup';

loadEnv();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { to: { type: 'string' }, 'skip-files': { type: 'boolean', default: false }, 'keep-sign-in': { type: 'boolean', default: false }, replace: { type: 'boolean', default: false } },
});
const folder = positionals[0];
if (!folder || !values.to) {
  console.error('Usage: npm run restore -- <backup folder> --to <database url> [--skip-files] [--keep-sign-in] [--replace]');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as Manifest;
const target = values.to;

const client = await connect(target);
let restore: Awaited<ReturnType<typeof pgTool>>;
try {
  restore = await pgTool('pg_restore', target, client);
  const existing = await client.query("select 1 from information_schema.tables where table_schema = 'public' and table_name = 'reforms'");
  if (existing.rowCount && !values.replace) {
    throw new Error(`${describeDatabase(target)} already has the app's tables. Restore into an empty database, or add --replace to drop them first.`);
  }
  if (!existing.rowCount) {
    // A new database still has an empty public schema; anything else in it means it is not empty.
    const objects = await client.query("select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' limit 1");
    if (objects.rowCount) throw new Error(`${describeDatabase(target)} is not empty. Restore into an empty database, or add --replace.`);
  }
  // The dump creates the schemas itself.
  for (const schema of SCHEMAS) await client.query(`drop schema if exists ${schema} cascade`);
} finally {
  await client.end();
}

await restore.run(['--no-owner', '--no-privileges', '--exit-on-error'], { stdin: join(folder, 'database.dump') });
console.log(`Database restored with ${restore.how}.`);

const check = await connect(target);
let problems: string[];
try {
  await applyPlatformGrants(check, (line) => console.log(line));
  // Compare first: clearing sign-in links below is itself recorded in the audit log.
  const counts = await tableCounts(check);
  problems = Object.entries(manifest.tables)
    .filter(([table, n]) => counts[table] !== n)
    .map(([table, n]) => `${table}: ${counts[table] ?? 'missing'} rows, the backup had ${n}`);
  if (!values['keep-sign-in']) {
    // As the server (no signed-in person), so the account guards allow it.
    const cleared = await check.query('update app_users set auth_user_id = null where auth_user_id is not null');
    console.log(`Sign-in links cleared (${cleared.rowCount}): people link again by email at their next sign-in.`);
  }
} finally {
  await check.end();
}

if (!values['skip-files'] && manifest.files.length > 0) {
  const { storage } = await import('../src/lib/platform/s3-storage');
  await storage.ensureBucket();
  for (const file of manifest.files) {
    const bytes = new Uint8Array(readFileSync(join(folder, 'files', file.key)));
    if (sha256(bytes) !== file.sha256) {
      problems.push(`${file.key}: the backup copy does not match its checksum`);
      continue;
    }
    await storage.put(file.key, bytes, 'application/octet-stream');
    const back = await storage.read(file.key, file.size + 1);
    if (sha256(back) !== file.sha256) problems.push(`${file.key}: stored copy does not match`);
  }
  console.log(`Files restored and checked: ${manifest.files.length}.`);
}

if (problems.length > 0) {
  console.error(`Restore finished with problems:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Restore checked: every table has the same number of rows as the backup${values['skip-files'] ? '' : ', and every file matches'}.`);

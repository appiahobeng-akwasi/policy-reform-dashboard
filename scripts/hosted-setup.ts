// Sets up the secrets for the hosted trial in one go (decision 88, docs/04 section 6b):
//   npm run hosted:setup
// Run it yourself in a terminal: it asks for three values, hides what you type and checks each
// one straight away. It fetches the Supabase secret key itself (Supabase command-line tool),
// writes .env.hosted (git-ignored), then sends the secrets to Vercel (Sensitive) and to GitHub
// (Actions secrets) with your signed-in Vercel and GitHub tools. It never prints a secret.
// Safe to run again: values already saved that still work are kept, so a second run asks for
// nothing. Database connections are verified against Supabase's root certificate (decision 91).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { decodeCa, pgConnection } from '../src/lib/db-ssl';
import { ROOT } from './lib/db';
import { askHidden } from './lib/prompt';
import { cleanPasted, githubSecrets, hostingTarget, pickSecretKey, poolerHosts, poolerUrl, readEnvFile, updateEnvFile, vercelSecrets, withSslMode } from './lib/hosted';

const ENV_PATH = join(ROOT, '.env.hosted');
// Supabase's public root certificate, committed with the code (decision 91).
const CA_PATH = join(ROOT, 'db', 'platform', 'supabase-root-2021.crt');

if (!process.stdin.isTTY) {
  console.error('Run this yourself in a terminal window: it needs to ask you for values.');
  process.exit(1);
}
if (!existsSync(ENV_PATH)) {
  console.error('.env.hosted is missing. Ask for it to be made again (docs/04 section 6b).');
  process.exit(1);
}
for (const tool of ['supabase', 'vercel', 'gh']) {
  if (spawnSync('sh', ['-c', `command -v ${tool}`]).status !== 0) {
    console.error(`The ${tool} command-line tool is not installed.`);
    process.exit(1);
  }
}

let fileText = readFileSync(ENV_PATH, 'utf8');
const save = (updates: Record<string, string>) => {
  fileText = updateEnvFile(fileText, updates);
  writeFileSync(ENV_PATH, fileText, { mode: 0o600 });
};
const current = () => readEnvFile(fileText);
let target: ReturnType<typeof hostingTarget>;
try {
  target = hostingTarget(current());
} catch (error) {
  fail((error as Error).message);
}
const { projectRef: PROJECT_REF, region: REGION, vercelProject: VERCEL_PROJECT, vercelScope: VERCEL_SCOPE } = target;
const DASHBOARD = `https://supabase.com/dashboard/project/${PROJECT_REF}`;

console.log('\nHosted set-up for the Pillar 1 dashboard. Nothing you type is shown or stored anywhere but .env.hosted, Vercel and GitHub.\n');

// 0. The root certificate every database connection is checked against.
const ca = existsSync(CA_PATH) ? decodeCa(readFileSync(CA_PATH, 'utf8')) : null;
if (!ca) fail(`The Supabase root certificate is missing at ${CA_PATH}.`);
save({ DATABASE_SSL_CA: Buffer.from(ca, 'utf8').toString('base64') });

// 1. Supabase secret key: fetched, not pasted.
step(1, 'Supabase secret key');
const keys = spawnSync('supabase', ['projects', 'api-keys', '--project-ref', PROJECT_REF, '-o', 'json'], { encoding: 'utf8' });
const secretKey = keys.status === 0 ? pickSecretKey(keys.stdout) : null;
if (!secretKey) fail('Could not get the secret key. Sign in to the Supabase tool with `supabase login` (the account that owns this Supabase project), then run this again.');
if (!(await secretKeyWorks(current()['SUPABASE_URL']!, secretKey))) fail('Supabase did not accept the secret key it gave. Try again in a minute.');
save({ SUPABASE_SECRET_KEY: secretKey });
ok('fetched and checked.');

// 2. Database password: kept if the saved address still works, now with a verified connection.
step(2, 'Database password');
const saved = current()['DATABASE_URL'];
const savedVerified = saved ? withSslMode(saved, 'verify-full') : null;
if (savedVerified && (await connects(savedVerified))) {
  save({ DATABASE_URL: savedVerified });
  console.log('   The saved password still works: nothing to paste.');
} else {
  console.log(`   In Supabase open ${DASHBOARD}/database/settings`);
  console.log('   Click "Reset database password", then "Generate a password". Save it in your password manager, click "Reset password", then copy it.');
  for (;;) {
    const password = cleanPasted(await askHidden('   Paste the password and press Enter: '));
    if (!password) continue;
    process.stdout.write('   Checking');
    const databaseUrl = await findPooler(password);
    if (databaseUrl) {
      save({ DATABASE_URL: databaseUrl });
      break;
    }
    console.log('\n   That password did not work. A reset can take a minute to apply: wait, then paste it again.');
  }
}
ok('the database accepted it, over a verified connection.');

// 3. File storage key: kept if the saved pair still works.
step(3, 'File storage key');
const savedId = current()['S3_ACCESS_KEY_ID'];
const savedSecret = current()['S3_SECRET_ACCESS_KEY'];
if (savedId && savedSecret && (await storageKeyWorks(current(), savedId, savedSecret))) {
  console.log('   The saved storage key still works: nothing to paste.');
} else {
  console.log(`   In Supabase open ${DASHBOARD}/storage/s3`);
  console.log('   Under "Access keys" click "New access key", describe it as "dashboard app", then copy each value when asked.');
  for (;;) {
    const id = cleanPasted(await askHidden('   Paste the Access key ID and press Enter: '));
    const secret = cleanPasted(await askHidden('   Paste the Secret access key and press Enter: '));
    if (!id || !secret) continue;
    process.stdout.write('   Checking');
    if (await storageKeyWorks(current(), id, secret)) {
      save({ S3_ACCESS_KEY_ID: id, S3_SECRET_ACCESS_KEY: secret });
      break;
    }
    console.log('\n   Supabase storage did not accept that pair. Check you copied both from the same key, or make a new key, then paste again.');
  }
}
ok('storage accepted it.');

// 4. Secrets made here: the jobs secret (already in the file) and the backup passphrase.
step(4, 'Jobs secret and backup passphrase');
if (!current()['JOBS_SECRET']) save({ JOBS_SECRET: randomBytes(32).toString('hex') });
if (!current()['BACKUP_PASSPHRASE']) save({ BACKUP_PASSPHRASE: randomBytes(24).toString('base64url') });
ok('ready. Copy the BACKUP_PASSPHRASE line from .env.hosted into your password manager later: without it no backup can be read.');

// 5. Vercel.
step(5, 'Sending secrets to Vercel');
const linkFile = join(ROOT, '.vercel', 'project.json');
const linked = existsSync(linkFile) && (JSON.parse(readFileSync(linkFile, 'utf8')) as { projectName?: string }).projectName === VERCEL_PROJECT;
if (!linked) {
  const link = spawnSync('vercel', ['link', '--yes', '--project', VERCEL_PROJECT, '--scope', VERCEL_SCOPE], { cwd: ROOT, encoding: 'utf8' });
  if (link.status !== 0) fail('Could not link this folder to the Vercel project. Run `vercel login`, then this again.');
}
for (const [name, value] of vercelSecrets(current())) {
  const added = spawnSync('vercel', ['env', 'add', name, 'production', '--sensitive', '--force', '--yes'], { cwd: ROOT, input: value, encoding: 'utf8' });
  if (added.status !== 0) fail(`Vercel refused ${name}. Run \`vercel login\`, then this again.`);
  console.log(`   ${name}: set`);
}
ok('done.');

// 6. GitHub.
step(6, 'Sending secrets to GitHub (scheduled jobs and backups)');
for (const [name, value] of githubSecrets(current())) {
  const set = spawnSync('gh', ['secret', 'set', name], { cwd: ROOT, input: value, encoding: 'utf8' });
  if (set.status !== 0) fail(`GitHub refused ${name}. Run \`gh auth login\`, then this again.`);
  console.log(`   ${name}: set`);
}
ok('done.');

console.log('\nAll set. Go back to Claude and say "done".\n');
process.exit(0);

// --- helpers ---

function step(n: number, title: string): void {
  console.log(`\n${n}. ${title}`);
}

function ok(message: string): void {
  console.log(`   OK: ${message}`);
}

function fail(message: string): never {
  console.error(`\n   Stopped: ${message}`);
  process.exit(1);
}

async function secretKeyWorks(supabaseUrl: string, key: string): Promise<boolean> {
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    return response.ok;
  } catch {
    return false;
  }
}

/** Whether this address connects, checking the certificate and host name. */
async function connects(url: string): Promise<boolean> {
  const client = new pg.Client({ ...pgConnection(url, ca), connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The session pooler address that accepts this password, or null. */
async function findPooler(password: string): Promise<string | null> {
  for (const host of poolerHosts(REGION)) {
    process.stdout.write('.');
    const url = poolerUrl({ ref: PROJECT_REF, password, host, port: 5432 });
    // Wrong password, or the project is on the other pooler host: try the next.
    if (await connects(url)) return url;
  }
  return null;
}

async function storageKeyWorks(env: Record<string, string>, accessKeyId: string, secretAccessKey: string): Promise<boolean> {
  const client = new S3Client({
    endpoint: env['S3_ENDPOINT'] ?? '',
    region: env['S3_REGION'] ?? '',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  try {
    await client.send(new ListBucketsCommand({}));
    return true;
  } catch {
    return false;
  } finally {
    client.destroy();
  }
}

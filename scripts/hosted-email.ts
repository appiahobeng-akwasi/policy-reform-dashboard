// Sends every hosted email through Resend (decision 93): sign-in emails from Supabase Auth, and
// reminders and digests from the app.
//   npm run hosted:email
// Run it yourself in a terminal. It asks for a Resend API key and a Supabase access token,
// hides what you type and checks each one straight away. It never prints a secret. It:
//   1. checks the Resend key;
//   2. with a programme domain bought in Vercel: adds it to Resend (tracking off), writes
//      Resend's records and DMARC into the domain's DNS on Vercel, waits until Resend verifies
//      it, and makes a sending-only Resend key for that domain, which is the only key stored;
//   3. tells Supabase Auth to send through Resend with the app's own sign-in email, whose link
//      opens the "Finish signing in" page (a button press) so email scanners cannot use it up;
//   4. saves the app's email settings in .env.hosted and sends them to Vercel;
//   5. sends you a test email.
// Safe to run again: it picks up where it stopped.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { ROOT } from './lib/db';
import {
  appEmailEnv,
  authEmailProblems,
  checkDomain,
  checkSettings,
  dnsRecordsFor,
  domainOf,
  isTestSender,
  planDns,
  RESEND_REGION,
  RESEND_SMTP,
  RESEND_TEST_SENDER,
  SENDING_KEY_NAME,
  supabaseAuthEmailConfig,
  type EmailSettings,
  type ExistingDnsRecord,
  type ResendRecord,
} from './lib/hosted-email';
import { cleanPasted, hostingTarget, readEnvFile, updateEnvFile } from './lib/hosted';
import { ask, askHidden } from './lib/prompt';

const ENV_PATH = join(ROOT, '.env.hosted');
const SECRET_ONLY = new Set(['SMTP_PASS']);
const RESEND_API = 'https://api.resend.com';

if (!process.stdin.isTTY) {
  console.error('Run this yourself in a terminal window: it needs to ask you for values.');
  process.exit(1);
}
if (!existsSync(ENV_PATH)) {
  console.error('.env.hosted is missing. Run npm run hosted:setup first (docs/04 section 6b).');
  process.exit(1);
}
if (spawnSync('sh', ['-c', 'command -v vercel']).status !== 0) {
  console.error('The vercel command-line tool is not installed.');
  process.exit(1);
}

let fileText = readFileSync(ENV_PATH, 'utf8');
const env = () => readEnvFile(fileText);
let target: ReturnType<typeof hostingTarget>;
try {
  target = hostingTarget(env());
} catch (error) {
  fail((error as Error).message);
}
const { projectRef: PROJECT_REF, vercelProject: VERCEL_PROJECT, vercelScope: VERCEL_SCOPE, vercelTeamId: VERCEL_TEAM } = target;
const AUTH_CONFIG = `https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`;
const siteUrl = env()['APP_BASE_URL'];
if (!siteUrl) fail('APP_BASE_URL is empty in .env.hosted.');

console.log('\nEmail set-up for the Pillar 1 dashboard (Resend). Nothing you type is shown or stored anywhere but .env.hosted, Supabase and Vercel.\n');

// 0. Who the emails come from. Enter keeps what is saved.
const saved = /^(.*?)\s*<([^>]+)>$/.exec(env()['EMAIL_FROM'] ?? '');
const savedAddress = saved && !saved[2]!.includes('YOUR-DOMAIN') ? saved[2]! : null;
const savedDomain = savedAddress && !isTestSender(savedAddress) ? domainOf(savedAddress) : '';
const domainAnswer = (await ask('Your domain, bought in Vercel (type "none" for Resend\'s test sender, which only reaches you)', savedDomain || env()['EMAIL_DOMAIN'] || 'none')).toLowerCase();
const domain = domainAnswer === 'none' ? null : domainAnswer;
if (domain) {
  try {
    checkDomain(domain);
  } catch (error) {
    fail((error as Error).message);
  }
}
const senderName = await ask('Sender name', (savedAddress && saved?.[1]) || 'Green Growth Programme');
const senderAddress = domain ? await ask('Sender address', savedAddress && domainOf(savedAddress) === domain ? savedAddress : `dashboard@${domain}`) : RESEND_TEST_SENDER;
if (domain && domainOf(senderAddress) !== domain) fail(`The sender address must end in @${domain}.`);
const emailsPerHour = Number(await ask('Sign-in emails allowed per hour, across the whole site', '100'));
const testTo = await ask('Send the test email to', target.adminEmail);

// 1. Resend API key. A domain set-up needs a Full access key; only a sending-only key is stored.
step(1, 'Resend API key');
console.log('   In Resend open https://resend.com/api-keys and click "Create API key". Name it "dashboard set-up",');
console.log(`   choose "${domain ? 'Full access' : 'Sending access'}", then copy the key (it starts with re_). Resend shows it only once.`);
let setupKey: string;
for (;;) {
  setupKey = cleanPasted(await askHidden('   Paste the API key and press Enter: '));
  if (!/^re_[A-Za-z0-9_]{8,}$/.test(setupKey)) {
    console.log('   A Resend API key starts with re_. Paste it again.');
    continue;
  }
  if (domain) {
    const list = await resend('GET', '/domains', setupKey);
    if (list.status === 401 || list.status === 403) {
      console.log('   Resend refused that key for a domain set-up. Make a key with "Full access", then paste it.');
      continue;
    }
    if (!list.ok) fail(`Resend did not answer as expected (HTTP ${list.status}). Try again in a minute.`);
    break;
  }
  if (await resendAccepts(setupKey)) break;
  console.log('   Resend did not accept that key. Check you copied all of it, or make a new key, then paste again.');
}
ok('Resend accepted it.');

let smtpKey = setupKey;
if (domain) {
  step(2, `Your domain ${domain} (Resend and Vercel DNS)`);
  const owned = vercelApi('GET', `/v5/domains/${domain}`);
  if (!owned.ok) fail(`${domain} is not in your Vercel team. Buy it in Vercel (Domains), or check the spelling, then run this again.`);

  // Resend: the domain, with tracking off (tracking rewrites links, sign-in links included).
  const list = (await (await resend('GET', '/domains', setupKey)).json()) as { data?: { id: string; name: string }[] };
  let id = list.data?.find((d) => d.name === domain)?.id;
  if (!id) {
    const created = await resend('POST', '/domains', setupKey, { name: domain, region: RESEND_REGION });
    if (!created.ok) fail(`Resend would not add ${domain} (HTTP ${created.status}).`);
    id = ((await created.json()) as { id: string }).id;
    console.log('   Added to Resend.');
  }
  await resend('PATCH', `/domains/${id}`, setupKey, { open_tracking: false, click_tracking: false });
  const details = (await (await resend('GET', `/domains/${id}`, setupKey)).json()) as { status: string; records: ResendRecord[] };

  // Vercel DNS: Resend's sending records and DMARC, never a second SPF record.
  let wanted: ReturnType<typeof dnsRecordsFor>;
  try {
    wanted = dnsRecordsFor(domain, details.records);
  } catch (error) {
    fail((error as Error).message);
  }
  const existing = ((vercelApi('GET', `/v4/domains/${domain}/records?limit=100`).json as { records?: ExistingDnsRecord[] }).records ?? []);
  const { add, conflicts } = planDns(wanted, existing);
  if (conflicts.length > 0) fail(`The domain already has records that clash: ${conflicts.join('; ')}. Remove them in Vercel (Domains > ${domain}), then run this again.`);
  for (const record of add) {
    const created = vercelApi('POST', `/v2/domains/${domain}/records`, { name: record.name, type: record.type, value: record.value, ttl: 60, ...(record.mxPriority ? { mxPriority: record.mxPriority } : {}) });
    if (!created.ok) fail(`Vercel refused the ${record.type} record for ${record.name || domain}.`);
    console.log(`   DNS: added ${record.type} ${record.name || '@'}`);
  }
  if (add.length === 0) console.log('   DNS: all records already there.');

  // Verification: usually a few minutes on Vercel's DNS.
  if (details.status !== 'verified') {
    await resend('POST', `/domains/${id}/verify`, setupKey);
    process.stdout.write('   Waiting for Resend to verify the domain (up to 15 minutes)');
    let status = details.status;
    for (let i = 0; i < 45 && status !== 'verified'; i += 1) {
      await new Promise((r) => setTimeout(r, 20_000));
      process.stdout.write('.');
      status = (((await (await resend('GET', `/domains/${id}`, setupKey)).json()) as { status: string }).status);
      if (status === 'failed') fail('Resend could not verify the domain. Check the records in Vercel, then run this again.');
    }
    process.stdout.write('\n');
    if (status !== 'verified') fail('Not verified yet. DNS can take up to an hour: run this again later. It picks up where it stopped.');
  }
  ok(`${domain} is verified in Resend.`);

  // The stored key may only send, and only as this domain. Older ones are removed.
  const keys = (await (await resend('GET', '/api-keys', setupKey)).json()) as { data?: { id: string; name: string }[] };
  for (const old of keys.data?.filter((k) => k.name === SENDING_KEY_NAME) ?? []) await resend('DELETE', `/api-keys/${old.id}`, setupKey);
  const made = await resend('POST', '/api-keys', setupKey, { name: SENDING_KEY_NAME, permission: 'sending_access', domain_id: id });
  if (!made.ok) fail(`Resend would not make the sending key (HTTP ${made.status}).`);
  smtpKey = ((await made.json()) as { token: string }).token;
  if (!(await resendAccepts(smtpKey))) fail('The new sending key did not work. Run this again in a minute.');
  ok(`made the sending-only key "${SENDING_KEY_NAME}". You can delete "dashboard set-up" in Resend when this finishes.`);
}

const settings: EmailSettings = { apiKey: smtpKey, senderName, senderAddress, siteUrl, emailsPerHour };
try {
  checkSettings(settings);
} catch (error) {
  fail((error as Error).message);
}

// 3. Supabase Auth: our SMTP, our sign-in email, one-hour links, the hourly limit.
step(3, 'Sign-in emails (Supabase Auth)');
console.log('   In Supabase open https://supabase.com/dashboard/account/tokens, click "Generate new token",');
console.log('   name it "dashboard email set-up", choose an expiry of 1 day, then copy it. You can delete it afterwards.');
for (;;) {
  const token = process.env['SUPABASE_ACCESS_TOKEN'] || cleanPasted(await askHidden('   Paste the access token and press Enter: '));
  const update = await fetch(AUTH_CONFIG, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(supabaseAuthEmailConfig(settings)),
  }).catch(() => null);
  if (update?.status === 401 || update?.status === 403) {
    console.log('   Supabase did not accept that token. Make sure you are signed in to the account that owns this Supabase project, then paste a new one.');
    if (process.env['SUPABASE_ACCESS_TOKEN']) fail('SUPABASE_ACCESS_TOKEN was refused.');
    continue;
  }
  if (!update?.ok) fail(`Supabase refused the change (HTTP ${update?.status ?? 'no answer'}). Nothing else was changed; run this again in a minute.`);
  const check = await fetch(AUTH_CONFIG, { headers: { Authorization: `Bearer ${token}` } });
  const problems = check.ok ? authEmailProblems((await check.json()) as Record<string, unknown>, settings) : ['Could not read the settings back.'];
  if (problems.length > 0) fail(problems.join(' '));
  break;
}
ok('Supabase now sends sign-in emails through Resend, with the dashboard\'s own link (one hour, needs a button press).');

// 4. The app's own email (reminders and digests): .env.hosted and Vercel.
step(4, 'Reminders and digests (the app on Vercel)');
const appEnv = appEmailEnv(settings);
fileText = updateEnvFile(fileText, appEnv);
writeFileSync(ENV_PATH, fileText, { mode: 0o600 });
const linkFile = join(ROOT, '.vercel', 'project.json');
const linked = existsSync(linkFile) && (JSON.parse(readFileSync(linkFile, 'utf8')) as { projectName?: string }).projectName === VERCEL_PROJECT;
if (!linked) {
  const link = spawnSync('vercel', ['link', '--yes', '--project', VERCEL_PROJECT, '--scope', VERCEL_SCOPE], { cwd: ROOT, encoding: 'utf8' });
  if (link.status !== 0) fail('Could not link this folder to the Vercel project. Run `vercel login`, then this again.');
}
for (const [name, value] of Object.entries(appEnv)) {
  const args = ['env', 'add', name, 'production', '--force', '--yes', ...(SECRET_ONLY.has(name) ? ['--sensitive'] : [])];
  const added = spawnSync('vercel', args, { cwd: ROOT, input: value, encoding: 'utf8' });
  if (added.status !== 0) fail(`Vercel refused ${name}. Run \`vercel login\`, then this again.`);
  console.log(`   ${name}: set`);
}
ok('saved. The app uses them from its next deployment.');

// 5. A test email through the same server the app uses.
step(5, 'Test email');
try {
  await transport(settings.apiKey).sendMail({
    from: appEnv['EMAIL_FROM'],
    to: testTo,
    subject: 'Pillar 1 dashboard: email works | Le courriel fonctionne',
    text: 'This is a test from npm run hosted:email. Sign-in emails, reminders and digests now go through Resend.\n\nCeci est un test de npm run hosted:email.',
  });
  ok(`sent to ${testTo}. Check that inbox (and spam).`);
} catch (error) {
  const message = (error as Error).message;
  console.log(`   The test email was refused: ${message.slice(0, 200)}`);
  if (isTestSender(senderAddress)) console.log('   With the test sender, Resend only delivers to the email you signed up to Resend with.');
  console.log('   Everything else is set. Fix the address and run this again, or tell Claude.');
}

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

function transport(apiKey: string) {
  return nodemailer.createTransport({
    host: RESEND_SMTP.host,
    port: RESEND_SMTP.port,
    secure: RESEND_SMTP.secure,
    auth: { user: RESEND_SMTP.user, pass: apiKey },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

function resend(method: string, path: string, key: string, body?: unknown): Promise<Response> {
  return fetch(`${RESEND_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'ggp-dashboard-setup' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The Vercel REST API through the signed-in vercel tool, scoped to the team. */
function vercelApi(method: string, path: string, body?: unknown): { ok: boolean; json: unknown } {
  const sep = path.includes('?') ? '&' : '?';
  const run = spawnSync('vercel', ['api', `${path}${sep}teamId=${VERCEL_TEAM}`, '-X', method, '--raw', ...(body === undefined ? [] : ['--input', '-'])], {
    cwd: ROOT,
    encoding: 'utf8',
    ...(body === undefined ? {} : { input: JSON.stringify(body) }),
  });
  let json: unknown = null;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    // not JSON: treated as a failure below
  }
  const failed = run.status !== 0 || json === null || (typeof json === 'object' && json !== null && 'error' in json);
  return { ok: !failed, json };
}

async function resendAccepts(apiKey: string): Promise<boolean> {
  const t = transport(apiKey);
  try {
    await t.verify();
    return true;
  } catch {
    return false;
  } finally {
    t.close();
  }
}

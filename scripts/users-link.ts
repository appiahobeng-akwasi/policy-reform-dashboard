// Makes a one-time sign-in link for someone already added with users:add, without sending
// email (decision 88). For when email is not set up yet or a link went to spam. Example:
//   ENV_FILE=.env.hosted npm run users:link -- --email name@gmail.com
// Send the link to that person only, by a private channel. It works once and expires after the
// sign-in link lifetime set in Supabase Auth (one hour by default). See the SOP
// docs/manuals/sops/onboarding-a-new-user.md.
import { parseArgs } from 'node:util';
import { connect, databaseUrl, describeDatabase, loadEnv } from './lib/db';

loadEnv();
const { values } = parseArgs({ options: { email: { type: 'string' } } });
const email = values.email?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run users:link -- --email <email>');
  process.exit(1);
}

const url = databaseUrl();
const client = await connect(url);
const allowed = await client
  .query<{ ok: boolean }>('select is_allowed_email($1) as ok', [email])
  .then((r) => r.rows[0]!.ok)
  .finally(() => client.end());
if (!allowed) {
  console.error(`${email} may not sign in on ${describeDatabase(url)}. Add them first with npm run users:add.`);
  process.exit(1);
}

const { env } = await import('../src/lib/env');
const { createSupabaseAuthAdmin } = await import('../src/lib/platform/supabase-auth-admin');
const { signInLinkUrl } = await import('../src/lib/auth/sign-in-link');
const admin = createSupabaseAuthAdmin();
if (!admin) {
  console.error('SUPABASE_SECRET_KEY is not set, so no link can be made.');
  process.exit(1);
}
const token = await admin.createSignInToken(email);
if (!token) {
  console.error('The sign-in service refused to make a link. Check SUPABASE_URL and SUPABASE_SECRET_KEY.');
  process.exit(1);
}
console.log(`One-time sign-in link for ${email}. It works once; send it to them only:`);
console.log(signInLinkUrl(env.appBaseUrl, token));

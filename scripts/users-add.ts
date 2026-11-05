// Adds someone who may sign in. Example:
//   npm run users:add -- --email name@gmail.com --name "Full Name" --role reform_lead --scope RA1:approve
// Works on any database DATABASE_URL points to, including a hosted one. See the SOP
// docs/manuals/sops/onboarding-a-new-user.md.
import { parseArgs } from 'node:util';
import { connect, databaseUrl, describeDatabase, loadEnv } from './lib/db';
import { addUser, parseScope, ROLES, type Role } from './lib/users';

loadEnv();
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    language: { type: 'string', default: 'en' },
    scope: { type: 'string', multiple: true, default: [] },
  },
});

if (!values.email || !values.name || !values.role) {
  console.error(`Usage: npm run users:add -- --email <email> --name "<full name>" --role <${ROLES.join('|')}> [--language en|fr] [--scope RA1[:approve]]...`);
  process.exit(1);
}

const url = databaseUrl();
const client = await connect(url);
try {
  const userId = await addUser(client, {
    email: values.email,
    name: values.name,
    role: values.role as Role,
    language: values.language === 'fr' ? 'fr' : 'en',
    scope: values.scope.map(parseScope),
  });
  console.log(`Added ${values.email} as ${values.role} on ${describeDatabase(url)} (user ${userId}). They can now sign in with a magic link.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}

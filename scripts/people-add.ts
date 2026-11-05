// Adds a person who owns items but will not sign in (decision 24). Example:
//   npm run people:add -- --name "Ada Example" --institution "Ministry of Agriculture" --role-title "Director of Planning"
// To let someone sign in, use users:add instead. A people page comes with the users admin (build step 11).
import { parseArgs } from 'node:util';
import { connect, databaseUrl, describeDatabase, loadEnv } from './lib/db';
import { addPerson } from './lib/users';

loadEnv();
const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    email: { type: 'string' },
    institution: { type: 'string' },
    'role-title': { type: 'string' },
    language: { type: 'string', default: 'fr' },
  },
});

if (!values.name) {
  console.error('Usage: npm run people:add -- --name "<full name>" [--email <email>] [--institution <name or acronym>] [--role-title "<title>"] [--language fr|en]');
  process.exit(1);
}

const url = databaseUrl();
const client = await connect(url);
try {
  const personId = await addPerson(client, {
    name: values.name,
    ...(values.email ? { email: values.email } : {}),
    ...(values.institution ? { institution: values.institution } : {}),
    ...(values['role-title'] ? { roleTitle: values['role-title'] } : {}),
    language: values.language === 'en' ? 'en' : 'fr',
  });
  console.log(`Added ${values.name} on ${describeDatabase(url)} (person ${personId}). They can now be chosen as an owner.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}

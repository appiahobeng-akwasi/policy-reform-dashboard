// npm run db:migrate: apply only the migrations and seed files not yet applied.
// Safe to run again and again. Use this for hosted or self-hosted databases.
import { applyPending, applyPlatformGrants, connect, databaseUrl, describeDatabase, loadEnv } from './lib/db';

loadEnv();
const url = databaseUrl();
const client = await connect(url);
try {
  console.log(`Migrating ${describeDatabase(url)}`);
  const applied = await applyPending(client, console.log);
  await applyPlatformGrants(client, console.log);
  console.log(applied.length === 0 ? 'Nothing to apply: the database is up to date.' : `Done: ${applied.length} files applied.`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}

// npm run db:reset: rebuild the local database from scratch.
// Drops everything, applies db/migrations in order, then loads db/seed.
// Runs only against a database on this machine.
import { applyPending, applyPlatformGrants, connect, databaseUrl, describeDatabase, isLocalDatabase, loadEnv } from './lib/db';

loadEnv();
const url = databaseUrl();

if (!isLocalDatabase(url)) {
  console.error(
    `Refusing to reset ${describeDatabase(url)}: db:reset deletes all data and only runs on this machine.\n` +
      'To update a hosted database, use npm run db:migrate.',
  );
  process.exit(1);
}

const client = await connect(url);
try {
  console.log(`Resetting ${describeDatabase(url)}`);
  await client.query(`
    drop schema if exists app_meta cascade;
    drop schema if exists public cascade;
    create schema public;
    alter schema public owner to pg_database_owner;
    grant usage on schema public to public;
  `);
  const applied = await applyPending(client, console.log);
  await applyPlatformGrants(client, console.log);
  console.log(`Done: ${applied.length} files applied.`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}

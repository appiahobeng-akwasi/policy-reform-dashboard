// npm run sample:load   loads the sample RA1 structure (decision 39)
// npm run sample:remove removes it, and nothing else
import { connect, databaseUrl, describeDatabase, loadEnv } from './lib/db';
import { loadSample, removeSample } from './lib/sample';

loadEnv();
const action = process.argv[2];
if (action !== 'load' && action !== 'remove') {
  console.error('Usage: tsx scripts/sample-data.ts load|remove');
  process.exit(1);
}
const url = databaseUrl();
const client = await connect(url);
try {
  await client.query('begin');
  const result = action === 'load' ? await loadSample(client) : await removeSample(client);
  await client.query('commit');
  console.log(`${action === 'load' ? 'Loaded' : 'Removed'} ${result.items} sample items on ${describeDatabase(url)}.`);
} catch (error) {
  await client.query('rollback');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}

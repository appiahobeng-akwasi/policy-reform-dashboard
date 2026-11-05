// Backs up the database and file storage into one dated folder (decision 65). Examples:
//   npm run backup                       into ./backups/<date and time>/
//   npm run backup -- --out /mnt/second-copy
//   npm run backup -- --skip-files       database only
// Copy the folder to a second place under programme control. See the SOP
// docs/manuals/sops/backup-and-restore.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { connect, databaseUrl, describeDatabase, loadEnv } from './lib/db';
import { pgTool, SCHEMAS, sha256, tableCounts, type Manifest } from './lib/backup';

loadEnv();
const { values } = parseArgs({ options: { out: { type: 'string', default: 'backups' }, 'skip-files': { type: 'boolean', default: false } } });
const url = databaseUrl();
const folder = join(values.out!, new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z');
mkdirSync(folder, { recursive: true });

const client = await connect(url);
let manifest: Manifest;
let dump: Awaited<ReturnType<typeof pgTool>>;
try {
  dump = await pgTool('pg_dump', url, client);
  const migrations = (await client.query<{ file_name: string }>('select file_name from app_meta.schema_files order by file_name')).rows.map((r) => r.file_name);
  manifest = { format: 1, createdAt: new Date().toISOString(), source: describeDatabase(url), migrations, tables: await tableCounts(client), files: [] };
} finally {
  await client.end();
}

await dump.run(['--format=custom', '--no-owner', '--no-privileges', ...SCHEMAS.map((s) => `--schema=${s}`)], { stdout: join(folder, 'database.dump') });
console.log(`Database dumped with ${dump.how}: ${Object.keys(manifest.tables).length} tables.`);

if (!values['skip-files']) {
  const { storage } = await import('../src/lib/platform/s3-storage');
  for (const object of await storage.list()) {
    const bytes = await storage.read(object.key, 200 * 1024 * 1024);
    const path = join(folder, 'files', object.key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    manifest.files.push({ key: object.key, size: bytes.byteLength, sha256: sha256(bytes) });
  }
  console.log(`Files copied: ${manifest.files.length}.`);
}

writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Backup written to ${folder}`);

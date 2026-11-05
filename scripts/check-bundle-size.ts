// CLAUDE.md rule 9: first load at most 300 KB of JavaScript, compressed.
// Conservative check: the gzip size of ALL client JavaScript in the build,
// not only what one page loads. Run after npm run build.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const LIMIT_BYTES = 300 * 1024;
const CLIENT_DIR = join(import.meta.dirname, '../dist/client');

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

let files: string[];
try {
  files = jsFiles(CLIENT_DIR);
} catch {
  console.error('No build found. Run npm run build first.');
  process.exit(1);
}

const total = files.reduce((sum, file) => sum + gzipSync(readFileSync(file)).length, 0);
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
console.log(`Client JavaScript, gzipped: ${kb(total)} in ${files.length} files (limit ${kb(LIMIT_BYTES)}).`);
if (total > LIMIT_BYTES) {
  console.error('Over the 300 KB budget. Move work to the server or split the island.');
  process.exit(1);
}

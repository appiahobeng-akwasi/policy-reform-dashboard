// Real Excel workbooks for tests, built with SheetJS like the official template:
// README (version in B2), Lists, and data sheets with the template's headings.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';

// Read as a file (not imported) so both Vitest and Playwright's runner can load it.
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../../templates/template_manifest.v1.json'), 'utf8')) as {
  version: string;
  sheets: Record<string, string[]>;
};

export const SHEET_COLUMNS = manifest.sheets;
type Value = string | number | boolean | Date | null | { formula: string };

export type BookSpec = {
  version?: string | null;
  sheets: Record<string, Record<string, Value>[]>;
  /** Replace a sheet's headings (to test F05). */
  headers?: Record<string, string[]>;
  macro?: boolean;
};

export function workbook(spec: BookSpec): Buffer {
  const book = XLSX.utils.book_new();
  const readme = XLSX.utils.aoa_to_sheet([['GGP Pillar 1 Policy Reform Dashboard: bulk upload template'], ['Template version', spec.version === undefined ? manifest.version : spec.version]]);
  XLSX.utils.book_append_sheet(book, readme, 'README');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['delivery_status'], ['on_track']]), 'Lists');
  for (const [name, rows] of Object.entries(spec.sheets)) {
    const columns = spec.headers?.[name] ?? SHEET_COLUMNS[name] ?? [];
    const grid: unknown[][] = [columns, ...rows.map((row) => columns.map((c) => (row[c] !== undefined && row[c] !== null && typeof row[c] === 'object' && 'formula' in (row[c] as object) ? null : (row[c] ?? null))))];
    const sheet = XLSX.utils.aoa_to_sheet(grid, { dateNF: 'yyyy-mm-dd' });
    rows.forEach((row, r) => {
      columns.forEach((c, i) => {
        const value = row[c];
        if (value && typeof value === 'object' && 'formula' in value) sheet[XLSX.utils.encode_cell({ r: r + 1, c: i })] = { t: 'n', f: value.formula };
      });
    });
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  if (spec.macro) {
    (book as XLSX.WorkBook & { vbaraw?: Buffer }).vbaraw = Buffer.from('fake macro project');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsm', bookVBA: true }) as Buffer;
  }
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function csv(sheet: string, rows: Record<string, string>[]): Buffer {
  const columns = SHEET_COLUMNS[sheet] ?? [];
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return Buffer.from([columns.join(','), ...rows.map((row) => columns.map((c) => quote(row[c] ?? '')).join(','))].join('\n'));
}

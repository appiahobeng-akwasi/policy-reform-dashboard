// Reads an uploaded workbook or CSV, safely (docs/04 security checklist):
//   - the ZIP is inspected before anything is unpacked: too many files or too much unpacked
//     data ("zip bomb") and the file is not opened;
//   - SheetJS reads values only; formulas are noted (rule F06) but never calculated;
//   - at most 2,001 data rows per sheet are read, enough to show rule F07's limit is passed.
// The result holds what the file rules need (WorkbookInfo) and each data row's cells by column.
import * as XLSX from 'xlsx';
import manifest from '../../../templates/template_manifest.v1.json';
import { zipEntries } from '../evidence/sniff';
import type { WorkbookInfo } from '../gate/types';

export type Cell = string | number | boolean | null;
export type SourceRow = { row: number; cells: Record<string, Cell> };
export type ReadResult = { workbook: WorkbookInfo; sheets: Record<string, SourceRow[]> };

const TEMPLATE_SHEETS: Record<string, readonly string[]> = manifest.sheets;
const NOT_DATA = new Set(['README', 'Lists']);
const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 1000;
const MAX_ROWS_READ = 2001;

function extension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

/** A cell as the gate should see it: dates as YYYY-MM-DD (time-zone safe), never a formula. */
function cellValue(cell: XLSX.CellObject | undefined): Cell {
  if (!cell || cell.t === 'z') return null;
  if (cell.t === 'b') return Boolean(cell.v);
  if (cell.t === 'n' && typeof cell.v === 'number') {
    if (cell.z !== undefined && XLSX.SSF.is_date(cell.z)) {
      const d = XLSX.SSF.parse_date_code(cell.v);
      return `${String(d.y).padStart(4, '0')}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }
    return cell.v;
  }
  if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
  if (cell.t === 'e') return cell.w ?? '#ERROR';
  const text = String(cell.v ?? '');
  return text.trim() === '' ? null : text;
}

function isSafeZip(bytes: Uint8Array): { safe: boolean; hasMacros: boolean } {
  const entries = zipEntries(bytes);
  if (entries === null) return { safe: false, hasMacros: false };
  const unpacked = entries.reduce((sum, entry) => sum + entry.size, 0);
  const hasMacros = entries.some((entry) => /vbaProject\.bin$/i.test(entry.name));
  return { safe: entries.length <= MAX_ZIP_ENTRIES && unpacked <= MAX_UNPACKED_BYTES, hasMacros };
}

export function readUpload(bytes: Uint8Array, fileName: string, sha256: string): ReadResult {
  const workbook: WorkbookInfo = { fileName, bytes: bytes.length, sha256, hasMacros: false, templateVersion: null, sheets: [], readable: true };
  const sheets: Record<string, SourceRow[]> = {};
  const ext = extension(fileName);
  const isCsv = ext === 'csv';

  let book: XLSX.WorkBook;
  try {
    if (isCsv) {
      if (bytes.includes(0)) throw new Error('binary data in a CSV');
      book = XLSX.read(new TextDecoder().decode(bytes), { type: 'string', raw: true, dense: true, sheetRows: MAX_ROWS_READ + 1 });
    } else {
      const zip = isSafeZip(bytes);
      workbook.hasMacros = zip.hasMacros;
      if (!zip.safe) throw new Error('not a safe workbook');
      book = XLSX.read(bytes, { type: 'array', dense: true, cellFormula: true, cellNF: true, cellHTML: false, cellDates: false, sheetRows: MAX_ROWS_READ + 1 });
    }
  } catch {
    return { workbook: { ...workbook, readable: false }, sheets };
  }

  const readme = book.Sheets['README'];
  if (readme) {
    const version = cellValue(readme['!data']?.[1]?.[1]);
    workbook.templateVersion = version === null ? null : String(version).trim();
  }

  for (const sheetName of book.SheetNames) {
    if (NOT_DATA.has(sheetName)) continue;
    const grid = book.Sheets[sheetName]?.['!data'] ?? [];
    const headers = (grid[0] ?? []).map((cell) => String(cellValue(cell) ?? '').trim());
    while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop();
    // A CSV has one unnamed sheet: name it after the template sheet whose headings it matches.
    const name = isCsv
      ? (Object.entries(TEMPLATE_SHEETS).find(([, columns]) => columns.length === headers.length && columns.every((c, i) => c === headers[i]))?.[0] ?? sheetName)
      : sheetName;
    const formulaCells: string[] = [];
    const rows: SourceRow[] = [];
    grid.forEach((cells, r) => {
      cells?.forEach((cell, c) => {
        if (cell?.f) formulaCells.push(XLSX.utils.encode_cell({ r, c }));
      });
      if (r === 0) return;
      const values: Record<string, Cell> = {};
      headers.forEach((header, c) => {
        if (header) values[header] = cellValue(cells?.[c]);
      });
      if (Object.values(values).some((v) => v !== null)) rows.push({ row: r + 1, cells: values });
    });
    workbook.sheets.push({ name, headers, dataRows: rows.length, formulaCells });
    sheets[name] = rows;
  }
  return { workbook, sheets };
}

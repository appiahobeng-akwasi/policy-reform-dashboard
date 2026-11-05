// File rules F01 to F08 (bulk upload only). Any failure stops the run before rows are read.
// They work on what the server read from the workbook (WorkbookInfo); reading real Excel
// files comes in build step 7.
import manifest from '../../../../templates/template_manifest.v1.json';
import type { WorkbookInfo } from '../types';
import { checked, failIf, UNKNOWN, type Failure, type FileCheck } from './common';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS_PER_SHEET = 2000;
const TEMPLATE_SHEETS: Record<string, readonly string[]> = manifest.sheets;

export const TEMPLATE_VERSION = manifest.version;

function extension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

function knownSheets(workbook: WorkbookInfo): WorkbookInfo['sheets'] {
  return workbook.sheets.filter((sheet) => sheet.name in TEMPLATE_SHEETS);
}

export const FILE: Record<string, FileCheck> = {
  F01(workbook) {
    return failIf(!['xlsx', 'csv'].includes(extension(workbook.fileName)) || workbook.hasMacros || workbook.readable === false, { value: workbook.fileName });
  },

  F02(workbook) {
    return failIf(workbook.bytes > MAX_BYTES, { value: workbook.bytes });
  },

  F03(workbook, env) {
    // A CSV file has no README sheet to carry the version.
    if (extension(workbook.fileName) === 'csv') return checked([]);
    const supported = env.context.supportedTemplateVersions;
    if (supported === undefined) return UNKNOWN;
    return failIf(workbook.templateVersion === null || !supported.includes(workbook.templateVersion), {
      cell: 'README!B2',
      value: workbook.templateVersion ?? '',
    });
  },

  F04(workbook) {
    return failIf(knownSheets(workbook).length === 0);
  },

  F05(workbook) {
    const failures: Failure[] = [];
    for (const sheet of knownSheets(workbook)) {
      const expected = TEMPLATE_SHEETS[sheet.name] ?? [];
      const actual = sheet.headers.map((h) => h.trim());
      if (actual.length !== expected.length || actual.some((h, i) => h !== expected[i])) failures.push({ sheet: sheet.name });
    }
    return checked(failures);
  },

  F06(workbook) {
    return checked(
      workbook.sheets
        .filter((sheet) => sheet.formulaCells.length > 0)
        .map((sheet) => ({ sheet: sheet.name, cell: sheet.formulaCells[0] ?? null })),
    );
  },

  F07(workbook) {
    const sheets = knownSheets(workbook);
    const total = sheets.reduce((sum, sheet) => sum + sheet.dataRows, 0);
    const tooLong = sheets.find((sheet) => sheet.dataRows > MAX_ROWS_PER_SHEET);
    return failIf(total === 0 || tooLong !== undefined, { sheet: tooLong?.name ?? null });
  },

  F08(workbook, env) {
    if (env.context.acceptedUploads === undefined) return UNKNOWN;
    const date = env.context.acceptedUploads[workbook.sha256];
    return failIf(date !== undefined, { vars: { date } });
  },
};

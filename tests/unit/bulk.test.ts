// Bulk upload: reading real workbooks safely, the file rules on what was read, and turning
// template rows into submission rows (build step 7).
import { describe, expect, it } from 'vitest';
import manifest from '../../templates/template_manifest.v1.json';
import { csvCell } from '../../src/lib/bulk/csv';
import { columnForField, mapRow, SHEETS, UPLOAD_SNAPSHOT_TYPE, type Lookups } from '../../src/lib/bulk/map';
import { cellFor, columnLetter } from '../../src/lib/bulk/process';
import { readUpload } from '../../src/lib/bulk/read';
import { runGate } from '../../src/lib/gate/engine';
import { RULE_SET_V1 } from '../../src/lib/gate/rules';
import { baseContext } from '../dq/harness';
import { zip } from '../support/files';
import { csv, workbook } from '../support/workbooks';

const read = (bytes: Buffer, name = 'upload.xlsx') => readUpload(new Uint8Array(bytes), name, 'f'.repeat(64));
const fileFindings = (bytes: Buffer, name = 'upload.xlsx') => {
  const { workbook: info } = read(bytes, name);
  return runGate({ route: 'bulk_upload', rows: [], workbook: info }, baseContext(0)).findings.map((f) => f.ruleId);
};
const milestone = { milestone_id: 'MS-009', reform_id: 'RA1', name: 'Validation workshop held', status: 'on_track' };

describe('reading a workbook', () => {
  it('reads the template version, sheets, headings and rows', () => {
    const result = read(workbook({ sheets: { Milestones: [milestone, { ...milestone, milestone_id: 'MS-010' }] } }));
    expect(result.workbook).toMatchObject({ templateVersion: manifest.version, hasMacros: false, readable: true });
    expect(result.workbook.sheets.find((s) => s.name === 'Milestones')).toMatchObject({ headers: manifest.sheets.Milestones, dataRows: 2, formulaCells: [] });
    expect(result.sheets['Milestones']![0]).toEqual({ row: 2, cells: expect.objectContaining({ milestone_id: 'MS-009', status: 'on_track', owner_email: null }) });
  });

  it('turns Excel date cells into YYYY-MM-DD and keeps text that only looks like a date', () => {
    const result = read(workbook({ sheets: { Milestones: [{ ...milestone, planned_date: new Date(Date.UTC(2026, 11, 15)), forecast_date: '15/12/2026' }] } }));
    expect(result.sheets['Milestones']![0]!.cells).toMatchObject({ planned_date: '2026-12-15', forecast_date: '15/12/2026' });
  });

  it('notes formula cells without calculating them', () => {
    const result = read(workbook({ sheets: { Milestones: [{ ...milestone, comments: { formula: '1+1' } }] } }));
    expect(result.workbook.sheets.find((s) => s.name === 'Milestones')!.formulaCells).toEqual(['Q2']);
  });

  it('names a CSV after the template sheet whose headings it has', () => {
    const result = read(csv('Milestones', [{ milestone_id: 'MS-009', status: 'on_track' }]), 'milestones.csv');
    expect(result.workbook.sheets.map((s) => s.name)).toEqual(['Milestones']);
    expect(result.sheets['Milestones']![0]!.cells['milestone_id']).toBe('MS-009');
  });

  it('does not open a ZIP that would unpack to too much data (zip bomb)', () => {
    const bomb = zip({ '[Content_Types].xml': '<x/>', 'xl/workbook.xml': '<w/>' });
    // Claim 100 MB unpacked for the second entry in the central directory.
    const central = bomb.lastIndexOf(Buffer.from('xl/workbook.xml')) - 46;
    bomb.writeUInt32LE(100 * 1024 * 1024, central + 24);
    expect(read(bomb).workbook.readable).toBe(false);
  });

  it('marks a file that is not a workbook as unreadable', () => {
    expect(read(Buffer.from('this is not a spreadsheet')).workbook.readable).toBe(false);
  });
});

describe('file rules on real files (docs/03 section 11)', () => {
  it('a good file passes every file rule', () => {
    expect(fileFindings(workbook({ sheets: { Milestones: [milestone] } }))).toEqual([]);
  });

  it.each([
    ['a macro file (.xlsm)', () => fileFindings(workbook({ sheets: { Milestones: [milestone] }, macro: true }), 'upload.xlsm'), 'F01'],
    ['a macro hidden in a file named .xlsx', () => fileFindings(workbook({ sheets: { Milestones: [milestone] }, macro: true })), 'F01'],
    ['an unreadable file', () => fileFindings(Buffer.from('not a spreadsheet')), 'F01'],
    ['an old template version', () => fileFindings(workbook({ version: '0.9.0', sheets: { Milestones: [milestone] } })), 'F03'],
    ['no recognised sheet', () => fileFindings(workbook({ sheets: { Sheet1: [] } })), 'F04'],
    ['a renamed heading', () => fileFindings(workbook({ sheets: { Milestones: [milestone] }, headers: { Milestones: manifest.sheets.Milestones.map((h) => (h === 'status' ? 'Status' : h)) } })), 'F05'],
    ['a formula cell', () => fileFindings(workbook({ sheets: { Milestones: [{ ...milestone, comments: { formula: 'NOW()' } }] } })), 'F06'],
    ['2,001 rows on a sheet', () => fileFindings(workbook({ sheets: { Milestones: Array.from({ length: 2001 }, (_, i) => ({ ...milestone, milestone_id: `MS-${String(i % 1000).padStart(3, '0')}` })) } })), 'F07'],
    ['no data rows', () => fileFindings(workbook({ sheets: { Milestones: [] } })), 'F07'],
  ])('flags %s', (_label, run, rule) => {
    expect(run()).toContain(rule);
  });
});

describe('template rows to submission rows', () => {
  const person = '11111111-1111-4111-8111-111111111111';
  const lookups: Lookups = {
    idPatterns: RULE_SET_V1.idPatterns,
    personByEmail: (email) => (email === 'owner@example.org' ? person : undefined),
    stored: (entity, id) =>
      entity === 'milestone' && id === 'MS-009'
        ? { record: { milestone_id: 'MS-009', reform_id: 'RA1', name: 'Validation workshop held', status: 'on_track', next_action: null }, version: '2026-11-01 10:00:00+00' }
        : undefined,
    indicatorValue: (code, reform, period) => (code === 'O1.1' && reform === 'RA1' && period === '2026-10-31' ? { id: 'v-1', record: { value: 3 }, version: '' } : undefined),
  };
  const map = (sheet: string, cells: Record<string, string | number | boolean | null>) => mapRow(sheet, { row: 5, cells }, lookups);

  it('every template column has a mapping, and every mapped sheet is in the template', () => {
    for (const [sheet, columns] of Object.entries(manifest.sheets)) expect(Object.keys(SHEETS[sheet]!.columns).sort(), sheet).toEqual([...columns].sort());
    expect(Object.keys(SHEETS).sort()).toEqual(Object.keys(manifest.sheets).sort());
  });

  it('an existing ID is an update with only the changed, non-blank cells (decision 27)', () => {
    const row = map('Milestones', { milestone_id: 'MS-009', name: 'Validation workshop held', status: 'delayed', next_action: 'Book the venue', comments: null, reform_id: 'RA1' });
    expect(row).toMatchObject({ entity: 'milestone', op: 'update', id: 'MS-009', fields: { status: 'delayed', next_action: 'Book the venue' }, base_updated_at: '2026-11-01 10:00:00+00', ref: { sheet: 'Milestones', row: 5 } });
    expect(Object.keys(row.fields!)).toEqual(['status', 'next_action']);
  });

  it('an unknown ID is a new item with that ID; a blank ID a new item without one', () => {
    expect(map('Milestones', { milestone_id: 'MS-300', name: 'Decree published' })).toMatchObject({ op: 'create', id: 'MS-300', fields: { name: 'Decree published' } });
    expect(map('Milestones', { milestone_id: null, name: 'Decree published' })).not.toHaveProperty('id');
  });

  it('turns owner emails into people, and keeps an unknown email so B03 can flag it', () => {
    expect(map('Milestones', { milestone_id: 'MS-300', owner_email: ' Owner@Example.org ' }).fields).toMatchObject({ owner_person_id: person });
    expect(map('Milestones', { milestone_id: 'MS-300', owner_email: 'nobody@example.org' }).fields).toMatchObject({ owner_person_id: 'nobody@example.org' });
  });

  it('reads reform lists, linked objects, evidence and dependency lists', () => {
    expect(map('Risks', { risk_id: 'RK-300', reform_ids: 'RA1; RA2' }).links).toEqual([
      { object_type: 'reform', object_id: 'RA1' },
      { object_type: 'reform', object_id: 'RA2' },
    ]);
    expect(map('Evidence_Register', { evidence_id: 'EV-300', linked_objects: 'MS-009, DC-001, XYZ' }).links).toEqual([
      { object_type: 'milestone', object_id: 'MS-009' },
      { object_type: 'decision', object_id: 'DC-001' },
      { object_type: 'unknown', object_id: 'XYZ' },
    ]);
    expect(map('Deliverables', { deliverable_id: 'DL-RA1-001', evidence_ids: 'EV-001;EV-002', depends_on: 'DL-RA1-002' })).toMatchObject({ evidence_ids: ['EV-001', 'EV-002'], depends_on: ['DL-RA1-002'] });
  });

  it('reads yes/no (and oui/non) as true/false, and keeps anything else for B04', () => {
    expect(map('Milestones', { milestone_id: 'MS-300', is_decision_gate: 'yes' }).fields).toMatchObject({ is_decision_gate: true });
    expect(map('Stage_Updates', { stage_record_id: 'PT-001', escalation_needed: 'non' }).fields).toMatchObject({ escalation_needed: false });
    expect(map('Milestones', { milestone_id: 'MS-300', is_decision_gate: 'maybe' }).fields).toMatchObject({ is_decision_gate: 'maybe' });
  });

  it('matches indicator values on indicator, reform and period', () => {
    expect(map('Indicator_Values', { indicator_code: 'O1.1', reform_id: 'RA1', period_end: '2026-10-31', value: 4 })).toMatchObject({ op: 'update', id: 'v-1', fields: { value: 4 } });
    expect(map('Indicator_Values', { indicator_code: 'O1.1', reform_id: 'RA1', period_end: '2026-11-30', value: 4 })).toMatchObject({ op: 'create', fields: { snapshot_type: UPLOAD_SNAPSHOT_TYPE } });
  });

  it('attributes a row to its reported_by person only for the Secretariat (decision 33)', () => {
    const cells = { milestone_id: 'MS-009', status: 'delayed', reported_by_email: 'Owner@example.org' };
    expect(mapRow('Milestones', { row: 5, cells }, lookups, { reportedByPerRow: true }).on_behalf_of_person_id).toBe(person);
    expect(mapRow('Milestones', { row: 5, cells: { ...cells, reported_by_email: 'stranger@example.org' } }, lookups, { reportedByPerRow: true }).on_behalf_of_person_id).toBe('stranger@example.org');
    expect(mapRow('Milestones', { row: 5, cells }, lookups)).not.toHaveProperty('on_behalf_of_person_id');
    expect(columnForField('Milestones', 'on_behalf_of_person_id')).toBe('reported_by_email');
  });

  it('notes columns the dashboard does not use (decision 29), and never writes them', () => {
    const row = map('Stage_Updates', { stage_record_id: 'PT-001', validation_status: 'validated', reported_by_email: 'someone@example.org' });
    expect(row.ignored).toEqual(['validation_status']);
    expect(row.fields).not.toHaveProperty('validation_status');
    expect(row.fields).not.toHaveProperty('reported_by_email');
  });
});

describe('cells in messages and the gap list', () => {
  it('finds the template column and cell for a finding', () => {
    expect(columnForField('Milestones', 'owner_person_id')).toBe('owner_email');
    expect(columnForField('Risks', 'links')).toBe('reform_ids');
    expect(columnForField('Milestones', 'evidence')).toBe('evidence_ids');
    expect(columnLetter('Milestones', 'status')).toBe('L');
    expect(cellFor({ sheet: 'Milestones', rowRef: 14, field: 'status' })).toBe('L14');
    expect(cellFor({ sheet: 'Milestones', rowRef: 14, field: 'reform_id' })).toBe('B14');
    expect(cellFor({ sheet: 'Milestones', rowRef: 14, field: null })).toBeNull();
  });

  it('makes CSV cells safe: quoted, and never read as formulas', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('-1')).toBe(`"'-1"`);
    expect(csvCell('Row 2: plain')).toBe('"Row 2: plain"');
    expect(csvCell(null)).toBe('""');
  });
});

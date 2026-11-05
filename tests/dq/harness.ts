// A small, made-up world for the rule fixtures: three reforms, a few items and one person.
// Each fixture can override any part of the context or the workbook.
import manifest from '../../templates/template_manifest.v1.json';
import { SCHEMA_LISTS } from '../../src/lib/gate/entities';
import type { GateContext, GateInput, GateRow, Route, WorkbookInfo } from '../../src/lib/gate/types';

export const PERSON = '11111111-1111-4111-8111-111111111111';
export const TODAY = '2026-11-20';

const { reform_id: _reforms, yes_no: _yesNo, ...lookupLists } = manifest.lists;

export function baseContext(rowCount: number): GateContext {
  return {
    today: TODAY,
    mode: 'gate',
    lists: { ...lookupLists, ...SCHEMA_LISTS },
    existing: [
      'reform:RA1',
      'reform:RA2',
      'reform:RA3',
      'workstream:WS-RA1-01',
      'deliverable:DL-RA1-001',
      'milestone:MS-001',
      'milestone:MS-002',
      'reform_stage:PT-001',
      'risk:RK-001',
      'decision:DC-001',
      'evidence_item:EV-001',
      'indicator:O1.1',
      'indicator:P1.4',
      `person:${PERSON}`,
    ],
    stored: {
      'milestone:MS-001': {
        milestone_id: 'MS-001',
        scope: 'reform',
        reform_id: 'RA1',
        name: 'Land registry decree adopted',
        status: 'on_track',
        planned_date: '2026-12-15',
        owner_person_id: PERSON,
        next_action: 'Prepare the draft decree',
        last_confirmed_at: '2026-11-10T09:00:00Z',
      },
      'milestone:MS-002': {
        milestone_id: 'MS-002',
        scope: 'reform',
        reform_id: 'RA1',
        name: 'Validation workshop held',
        status: 'not_started',
        planned_date: '2027-01-20',
        owner_person_id: PERSON,
        next_action: 'Book the venue',
      },
      'reform_stage:PT-001': { stage_record_id: 'PT-001', reform_id: 'RA1', stage: 'problem_identified', status: 'complete', exit_date: '2026-05-04' },
    },
    evidenceLinked: ['milestone:MS-002'],
    evidenceWithLinks: ['EV-001'],
    rowScope: Array.from({ length: rowCount }, () => true),
    rowReforms: Array.from({ length: rowCount }, () => ['RA1']),
    lockedPeriods: ['2026-06-30'],
    previousValues: {},
    evidenceFiles: {},
    acceptedUploads: {},
    dependencies: [],
    supportedTemplateVersions: [manifest.version],
  };
}

export function baseWorkbook(): WorkbookInfo {
  return {
    fileName: 'Bulk_Upload_Template_v1.0.0.xlsx',
    bytes: 48_000,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    hasMacros: false,
    templateVersion: manifest.version,
    sheets: [{ name: 'Milestones', headers: [...manifest.sheets.Milestones], dataRows: 1, formulaCells: [] }],
  };
}

export type FixtureCase = {
  route: Route;
  rows: GateRow[];
  context?: Partial<GateContext>;
  workbook?: Partial<WorkbookInfo>;
  expect?: { field?: string; value?: string; sheet?: string; cell?: string };
};

export type Fixture = { rule: string; pass: FixtureCase; fail: FixtureCase };

export function buildCase(fixture: FixtureCase): { input: GateInput; context: GateContext } {
  const input: GateInput = { route: fixture.route, rows: fixture.rows };
  if (fixture.workbook !== undefined) input.workbook = { ...baseWorkbook(), ...fixture.workbook };
  return { input, context: { ...baseContext(fixture.rows.length), ...fixture.context } };
}

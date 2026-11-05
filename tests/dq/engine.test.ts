// The engine as a whole: rule set loading, the score formula (docs/03 section 2), run order,
// auto-fixes, reject reasons and browser hints. Per-rule behaviour is in rules.test.ts.
import { describe, expect, it } from 'vitest';
import rulesFile from '../../rules/dq_rules.v1.json';
import { assertRuleSetSupported, IMPLEMENTED_RULE_IDS, qualityScore, runGate } from '../../src/lib/gate/engine';
import { withoutRowPrefix } from '../../src/lib/gate/messages';
import { parseRuleSet, RULE_SET_V1 } from '../../src/lib/gate/rules';
import type { GateRow } from '../../src/lib/gate/types';
import { baseContext, baseWorkbook, PERSON } from './harness';

const workstream = (fields: Record<string, unknown> = {}): GateRow => ({
  entity: 'workstream',
  op: 'create',
  fields: {
    reform_id: 'RA1',
    name: 'Land registry reform',
    workstream_type: 'policy',
    owner_person_id: PERSON,
    start_date: '2026-11-01',
    due_date: '2027-03-31',
    status: 'on_track',
    progress_pct: 20,
    next_action: 'Hold the first working group',
    ...fields,
  },
});

describe('rule set', () => {
  it('the code implements exactly the rules in rules/dq_rules.v1.json', () => {
    expect(IMPLEMENTED_RULE_IDS).toEqual(RULE_SET_V1.rules.map((r) => r.id).sort());
    expect(() => assertRuleSetSupported(RULE_SET_V1)).not.toThrow();
  });

  it('refuses a rule set with a rule the code does not implement', () => {
    const extra = { ...rulesFile, rules: [...rulesFile.rules, { ...rulesFile.rules[0], id: 'B99', tier: 'blocking' }] };
    expect(() => assertRuleSetSupported(parseRuleSet(extra))).toThrow(/B99/);
  });

  it('reads version, threshold and weights from the file', () => {
    expect(RULE_SET_V1.version).toBe('1.0.0');
    expect(RULE_SET_V1.threshold).toBe(80);
    expect(RULE_SET_V1.rules.find((r) => r.id === 'Q01')?.weight).toBe(3);
  });

  it.each([
    ['not an object', 'x'],
    ['a scored rule without a weight', { ...rulesFile, rules: [{ ...rulesFile.rules.find((r) => r.id === 'Q01'), weight: null }] }],
    ['a duplicate rule', { ...rulesFile, rules: [rulesFile.rules[0], rulesFile.rules[0]] }],
    ['a missing French message', { ...rulesFile, rules: [{ ...rulesFile.rules[0], message_fr: undefined }] }],
  ])('rejects %s', (_label, document) => {
    expect(() => parseRuleSet(document)).toThrow(/Rule set is not valid/);
  });
});

describe('quality score (docs/03 section 2)', () => {
  it('the worked example scores 83.3', () => {
    expect(qualityScore(100, 120)).toBe(83.3);
  });

  it('79.95 rounds up to 80.0', () => {
    expect(qualityScore(1599, 2000)).toBe(80);
  });

  it('rounds half up and to one decimal', () => {
    expect(qualityScore(1, 3)).toBe(33.3);
    expect(qualityScore(2, 3)).toBe(66.7);
    expect(qualityScore(1999, 2000)).toBe(100);
    expect(qualityScore(1997, 2000)).toBe(99.9);
  });

  it('a submission with no applicable scored checks scores 100', () => {
    expect(qualityScore(0, 0)).toBe(100);
  });

  it('sums weights over every applicable (row, rule) pair', () => {
    // Each good new workstream: Q01 (3), Q05 (2) and Q08 (2) apply; the rest do not.
    const rows = [...Array.from({ length: 8 }, () => workstream()), workstream({ next_action: '' }), workstream({ next_action: null })];
    const result = runGate({ route: 'web_form', rows }, baseContext(rows.length));
    expect(result.scoredApplicable).toBe(70);
    expect(result.scoredPassed).toBe(64);
    expect(result.qualityScore).toBe(91.4);
    expect(result.ruleStats['Q01']).toEqual({ applicable: 30, passed: 24 });
  });
});

describe('pass rule', () => {
  it('passes with no blocking failures and a score of at least 80', () => {
    const result = runGate({ route: 'web_form', rows: [workstream()] }, baseContext(1));
    expect(result).toMatchObject({ outcome: 'pass', rejectReason: null, qualityScore: 100, blockingFailures: 0 });
  });

  it('one blocking failure rejects, whatever the score', () => {
    const result = runGate({ route: 'web_form', rows: [workstream({ reform_id: 'RA9' })] }, baseContext(1));
    expect(result).toMatchObject({ outcome: 'reject', rejectReason: 'blocking_rules', qualityScore: 100, rowsWithBlocking: 1 });
  });

  it('a score below 80 rejects', () => {
    const result = runGate({ route: 'web_form', rows: [workstream({ next_action: '', name: 'TBC' })] }, baseContext(1));
    expect(result.qualityScore).toBe(28.6);
    expect(result).toMatchObject({ outcome: 'reject', rejectReason: 'score_below_threshold' });
  });

  it('names both reasons when both apply', () => {
    const result = runGate({ route: 'web_form', rows: [workstream({ next_action: '', name: 'TBC', reform_id: 'RA9' })] }, baseContext(1));
    expect(result.rejectReason).toBe('blocking_and_score');
  });

  it('uses the threshold of the rule set it runs', () => {
    const strict = { ...RULE_SET_V1, threshold: 95 };
    const rows = [...Array.from({ length: 8 }, () => workstream()), workstream({ next_action: '' }), workstream({ next_action: '' })];
    expect(runGate({ route: 'web_form', rows }, baseContext(10), strict)).toMatchObject({ outcome: 'reject', threshold: 95 });
  });
});

describe('run order', () => {
  it('a file failure stops the run before any row is checked', () => {
    const result = runGate(
      { route: 'bulk_upload', rows: [workstream({ reform_id: 'RA9' })], workbook: { ...baseWorkbook(), fileName: 'upload.xls' } },
      baseContext(1),
    );
    expect(result).toMatchObject({ outcome: 'reject', rejectReason: 'file_rules', qualityScore: null, fileFailures: 1 });
    expect(result.findings.map((f) => f.ruleId)).toEqual(['F01']);
  });

  it('file rules run only for bulk uploads', () => {
    const fileRules = RULE_SET_V1.rules.filter((r) => r.tier === 'file');
    expect(fileRules.every((r) => r.routes !== 'all' && r.routes.length === 1 && r.routes[0] === 'bulk_upload')).toBe(true);
    const result = runGate({ route: 'web_form', rows: [workstream()], workbook: { ...baseWorkbook(), fileName: 'upload.xls' } }, baseContext(1));
    expect(result.findings.filter((f) => f.tier === 'file')).toEqual([]);
  });

  it('a blank ID on a new row is allowed on the web form only (B01)', () => {
    const milestone: GateRow = { entity: 'milestone', op: 'create', fields: { reform_id: 'RA1', name: 'Decree published in the gazette', owner_person_id: PERSON } };
    expect(runGate({ route: 'web_form', rows: [milestone] }, baseContext(1)).findings.filter((f) => f.ruleId === 'B01')).toEqual([]);
    expect(runGate({ route: 'bulk_upload', rows: [milestone] }, baseContext(1)).findings.filter((f) => f.ruleId === 'B01')).toHaveLength(1);
  });
});

describe('auto-fixes', () => {
  it('fixes the rows that will be saved, logs the fix and costs no score', () => {
    const row: GateRow = { entity: 'milestone', op: 'update', id: ' MS-001 ', fields: { status: 'On Track', reform_id: ' RA1 ' } };
    const result = runGate({ route: 'web_form', rows: [row] }, baseContext(1));
    expect(result.rows[0]).toMatchObject({ id: 'MS-001', fields: { status: 'on_track', reform_id: 'RA1' } });
    const fixes = result.findings.filter((f) => f.severity === 'fixed');
    expect(fixes.map((f) => [f.ruleId, f.field])).toEqual([
      ['X01', 'milestone_id'],
      ['X01', 'reform_id'],
      ['X02', 'status'],
    ]);
    expect(fixes.every((f) => f.weight === null)).toBe(true);
    expect(result.findings.filter((f) => f.ruleId === 'B04' || f.ruleId === 'B03')).toEqual([]);
    expect(result.outcome).toBe('pass');
    expect(fixes[2]!.messageEn).toBe('Row 1: "On Track" read as "on_track".');
  });
});

describe('messages', () => {
  it('fills placeholders in both languages', () => {
    const result = runGate({ route: 'web_form', rows: [workstream({ status: 'finished' })] }, baseContext(1));
    const b04 = result.findings.find((f) => f.ruleId === 'B04')!;
    expect(b04.messageEn).toBe(
      'Row 1: "finished" is not an accepted value for status. Choose one of: not_started, on_track, at_risk, delayed, blocked, complete, cancelled.',
    );
    expect(b04.messageFr).toMatch(/^Ligne 1 : « finished » n'est pas une valeur acceptée pour status\./);
  });

  it('uses the spreadsheet row and sheet for uploads', () => {
    const row = { ...workstream({ reform_id: 'RA9' }), id: 'WS-RA1-02', ref: { sheet: 'Workstreams', row: 7 } };
    const finding = runGate({ route: 'bulk_upload', rows: [row] }, baseContext(1)).findings.find((f) => f.ruleId === 'B03')!;
    expect(finding).toMatchObject({ sheet: 'Workstreams', rowRef: 7 });
    expect(finding.messageEn).toMatch(/^Row 7: /);
  });

  it('drops the row prefix for the web form, in both languages', () => {
    expect(withoutRowPrefix('Row 1: add the next action so the team knows what happens next.')).toBe(
      'Add the next action so the team knows what happens next.',
    );
    expect(withoutRowPrefix('Ligne 1 : indiquez la prochaine action.')).toBe('Indiquez la prochaine action.');
  });
});

describe('staleness at the gate (decision 20)', () => {
  it('Q23 never counts at the gate, even for a stale item', () => {
    const context = { ...baseContext(1), stored: { 'milestone:MS-001': { status: 'on_track', last_confirmed_at: '2026-07-29T09:00:00Z' } } };
    const result = runGate({ route: 'web_form', rows: [{ entity: 'milestone', op: 'update', id: 'MS-001', fields: {} }] }, context);
    expect(result.checksRun['Q23']).toBeUndefined();
    expect(result.findings.filter((f) => f.ruleId === 'Q23')).toEqual([]);
  });
});

describe('browser hints', () => {
  it('skips checks that need live data the browser does not have, rather than failing them', () => {
    const { existing: _existing, rowScope: _scope, lockedPeriods: _locked, ...partial } = baseContext(1);
    const result = runGate({ route: 'web_form', rows: [workstream({ reform_id: 'RA9' })] }, partial);
    expect(result.checksRun['B03']).toBeUndefined();
    expect(result.checksRun['B11']).toBeUndefined();
    expect(result.findings.filter((f) => f.ruleId === 'B03' || f.ruleId === 'B11')).toEqual([]);
    expect(result.checksRun['B04']).toBe(1);
  });
});

describe('the person a row was reported by (decision 33)', () => {
  it('must be a person in the system (B03)', () => {
    const row: GateRow = { ...workstream(), on_behalf_of_person_id: 'nobody@example.org' };
    const finding = runGate({ route: 'bulk_upload', rows: [{ ...row, id: 'WS-RA1-02' }] }, baseContext(1)).findings.find((f) => f.ruleId === 'B03');
    expect(finding).toMatchObject({ field: 'on_behalf_of_person_id', valueSeen: 'nobody@example.org' });
    expect(runGate({ route: 'bulk_upload', rows: [{ ...workstream(), id: 'WS-RA1-02', on_behalf_of_person_id: PERSON }] }, baseContext(1)).findings.filter((f) => f.ruleId === 'B03')).toEqual([]);
  });
});

describe('malformed input', () => {
  it('throws on an unknown entity, which is a bug in the form or the parser, not a user error', () => {
    expect(() => runGate({ route: 'web_form', rows: [{ entity: 'budget', op: 'create', fields: {} }] }, baseContext(1))).toThrow(/unknown entity/);
  });
});

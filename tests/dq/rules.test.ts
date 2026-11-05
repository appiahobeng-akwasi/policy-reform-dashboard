// CLAUDE.md rule 12: every rule has one passing and one failing fixture (tests/dq/fixtures/<rule>.json).
// The passing case must actually be checked by the rule (not skipped as "does not apply").
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGate } from '../../src/lib/gate/engine';
import { RULE_SET_V1 } from '../../src/lib/gate/rules';
import { buildCase, type Fixture } from './harness';

const DIR = join(import.meta.dirname, 'fixtures');
const fixtures: Fixture[] = readdirSync(DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Fixture);

describe('fixtures', () => {
  it('every rule in the rule set has a fixture file, and nothing else does', () => {
    expect(fixtures.map((f) => f.rule).sort()).toEqual(RULE_SET_V1.rules.map((r) => r.id).sort());
  });
});

describe.each(fixtures.map((f) => [f.rule, f] as const))('%s', (ruleId, fixture) => {
  const rule = RULE_SET_V1.rules.find((r) => r.id === ruleId)!;
  const severity = rule.tier === 'scored' ? 'warning' : rule.tier === 'autofix' ? 'fixed' : 'error';

  it('passes its passing fixture, having actually checked it', () => {
    const { input, context } = buildCase(fixture.pass);
    const result = runGate(input, context);
    expect(result.findings.filter((f) => f.ruleId === ruleId)).toEqual([]);
    if (rule.tier !== 'autofix') expect(result.checksRun[ruleId] ?? 0).toBeGreaterThan(0);
    if (rule.tier === 'scored') expect(result.ruleStats[ruleId]).toEqual({ applicable: rule.weight, passed: rule.weight });
  });

  it('flags its failing fixture', () => {
    const { input, context } = buildCase(fixture.fail);
    const result = runGate(input, context);
    const found = result.findings.filter((f) => f.ruleId === ruleId);
    expect(found.length).toBeGreaterThan(0);
    const first = found[0]!;
    expect(first.severity).toBe(severity);
    const expected = fixture.fail.expect ?? {};
    if (expected.field !== undefined) expect(first.field).toBe(expected.field);
    if (expected.value !== undefined) expect(first.valueSeen).toBe(expected.value);
    if (expected.sheet !== undefined) expect(first.sheet).toBe(expected.sheet);
    if (expected.cell !== undefined) expect(first.cell).toBe(expected.cell);
    expect(first.messageEn).not.toMatch(/\{\w+\}/);
    expect(first.messageFr).not.toMatch(/\{\w+\}/);
    if (rule.tier === 'scored') expect(result.ruleStats[ruleId]).toEqual({ applicable: rule.weight, passed: 0 });
    if (rule.tier === 'file' || rule.tier === 'blocking') expect(result.outcome).toBe('reject');
  });
});

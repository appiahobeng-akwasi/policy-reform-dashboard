// The rule set (rules/dq_rules.v1.json) is the single source of truth for what each rule is
// called, its tier, weight, entities, routes and messages (CLAUDE.md rule 3). The code only
// implements each check, keyed by rule ID.
import rulesV1 from '../../../rules/dq_rules.v1.json';
import type { Route, Tier } from './types';

export type Rule = {
  id: string;
  tier: Tier;
  appliesTo: readonly string[];
  field: string | null;
  weight: number | null;
  routes: 'all' | readonly Route[];
  autoFix: string | null;
  messageEn: string;
  messageFr: string;
};

export type RuleSet = {
  version: string;
  threshold: number;
  idPatterns: Record<string, string>;
  rules: readonly Rule[];
};

const TIERS: readonly Tier[] = ['file', 'blocking', 'scored', 'autofix'];
const ROUTES: readonly Route[] = ['web_form', 'bulk_upload', 'on_behalf'];

function fail(message: string): never {
  throw new Error(`Rule set is not valid: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) fail(`${where} must be a list of text`);
  return value as string[];
}

/** Reads and checks a rule set document (the JSON file, or the copy stored in dq_rulesets). */
export function parseRuleSet(document: unknown): RuleSet {
  if (!isRecord(document)) fail('not an object');
  const version = document['ruleset_version'];
  if (typeof version !== 'string') fail('ruleset_version missing');
  const passRule = document['pass_rule'];
  const threshold = isRecord(passRule) ? passRule['quality_score_min'] : undefined;
  if (typeof threshold !== 'number') fail('pass_rule.quality_score_min missing');
  const patterns = document['id_patterns'];
  if (!isRecord(patterns) || !Object.values(patterns).every((p) => typeof p === 'string')) fail('id_patterns missing');
  const list = document['rules'];
  if (!Array.isArray(list)) fail('rules missing');

  const seen = new Set<string>();
  const rules = list.map((raw, index): Rule => {
    if (!isRecord(raw)) fail(`rule ${index} is not an object`);
    const id = raw['id'];
    if (typeof id !== 'string' || !/^[FBQX][0-9]{2}$/.test(id)) fail(`rule ${index} has no valid id`);
    if (seen.has(id)) fail(`${id} appears twice`);
    seen.add(id);
    const tier = raw['tier'];
    if (typeof tier !== 'string' || !(TIERS as readonly string[]).includes(tier)) fail(`${id} has an unknown tier`);
    const weight = raw['weight'];
    if (tier === 'scored' && (typeof weight !== 'number' || weight <= 0 || !Number.isInteger(weight))) fail(`${id} needs a whole-number weight`);
    const routes = raw['routes'];
    if (routes !== 'all' && !stringList(routes, `${id}.routes`).every((r) => (ROUTES as readonly string[]).includes(r))) fail(`${id} has an unknown route`);
    const messageEn = raw['message_en'];
    const messageFr = raw['message_fr'];
    if (typeof messageEn !== 'string' || typeof messageFr !== 'string') fail(`${id} needs messages in English and French`);
    const field = raw['field'];
    const autoFix = raw['auto_fix'];
    return {
      id,
      tier: tier as Tier,
      appliesTo: stringList(raw['applies_to'], `${id}.applies_to`),
      field: typeof field === 'string' ? field : null,
      weight: typeof weight === 'number' ? weight : null,
      routes: routes === 'all' ? 'all' : (routes as Route[]),
      autoFix: typeof autoFix === 'string' ? autoFix : null,
      messageEn,
      messageFr,
    };
  });
  return { version, threshold, idPatterns: patterns as Record<string, string>, rules };
}

/** The rule set shipped with the app (bundled for browser hints). */
export const RULE_SET_V1: RuleSet = parseRuleSet(rulesV1);

// Build step 13: wording a saved review pack (decision 53).
import { describe, expect, it } from 'vitest';
import type { PackData } from '../../src/lib/reviews/pack';
import { packFileName, packTitle, renderPackBody, renderPackDocument } from '../../src/lib/reviews/render';

const meta = { version: 2, generatedAt: '2026-11-12T08:00:00Z', generatedBy: 'Secretariat <admin>' };
const pack: PackData = {
  schema: 1,
  reviewType: 'monthly_pillar_review',
  reviewDate: '2026-11-14',
  windowStart: '2026-10-13 23:00:00+00',
  dataAsOf: '2026-07-29',
  prepare: {
    reforms: [{ reformId: 'RA1', name: { en: 'Land governance', fr: 'Gouvernance foncière' }, stage: { en: 'Technical design', fr: 'Conception technique' }, rag: 'red', overdue: 4, due30: 1, stale: 6, risksHigh: 2, decisionsOpen: 1, hasSample: true }],
    programme: [{ objectType: 'milestone', objectId: 'MS-007', name: 'First QSR', reformId: null, owner: null, dueDate: '2026-12-01', daysOverdue: 0, isStale: false, rag: 'green', isSample: false }],
    staleTotal: 12,
    quality: { attempts: 10, firstTimePassRate: 62.5, averageScore: 91.2 },
  },
  review: {
    escalations: [{ level: 3, reason: 'overdue_14', objectType: 'milestone', objectId: 'MS-101', name: { en: 'Decree <signed>', fr: null }, reformId: 'RA1', owner: null, raisedAt: '2026-11-04T05:00:00Z' }],
    overdue: [],
    riskChanges: [{ riskId: 'RK-001', description: 'Political turnover', change: 'score', before: { inherent: 25, residual: 12, status: 'open' }, after: { inherent: 2, residual: 1, status: 'open' }, at: '2026-11-01T10:00:00Z' }],
    highRisks: [],
    indicators: [
      {
        code: 'O1.1',
        name: { en: 'Reforms adopted', fr: 'Réformes adoptées' },
        reformId: null,
        unit: '%',
        latest: { periodEnd: '2026-09-30', value: 12.5, confidence: 'high', isProxy: true },
        previous: { periodEnd: '2026-06-30', value: 10, confidence: 'high', isProxy: false },
        newSinceLastReview: true,
        targetY1: 20,
        targetY1Text: null,
        targetLop: null,
      },
    ],
  },
  decide: { open: [{ decisionId: 'DC-002', date: '2026-08-15', type: 'adapt', tier: 2, summary: 'Resequence RA2', followUpAction: 'Revise the plan', followUpDue: '2026-08-31', followUpOwner: 'Technical Secretariat', followUpOverdue: true, reforms: ['RA1', 'RA2'] }] },
  track: { implemented: [], actions: [] },
};

describe('the review pack in English and French', () => {
  it('has the four parts in order, using the governance words', () => {
    const en = renderPackBody('en', pack, meta);
    const order = ['1. Prepare', '2. Review', '3. Decide', '4. Track'].map((h) => en.indexOf(h));
    expect(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1]!))).toBe(true);
    expect(en).toContain('Tier 2 (reviews or endorses)');
    const fr = renderPackBody('fr', pack, meta);
    for (const h of ['1. Préparer', '2. Examiner', '3. Décider', '4. Suivre', 'Gouvernance foncière', 'Conception technique', 'Niveau 2 (examine ou entérine)']) expect(fr).toContain(h);
  });

  it('escapes everything that comes from the data', () => {
    const html = renderPackBody('en', pack, meta);
    expect(html).toContain('Decree &lt;signed&gt;');
    expect(html).toContain('Secretariat &lt;admin&gt;');
    expect(html).not.toContain('<signed>');
  });

  it('shows unconfirmed life-of-programme targets as not confirmed, and labels sample data', () => {
    const html = renderPackBody('en', pack, meta);
    expect(html).toContain('Not confirmed');
    expect(html).toContain('12.5%');
    expect(html).toContain('Sample');
    expect(renderPackBody('fr', pack, meta)).toContain('12,5%');
  });

  it('one decision row for a decision linked to two reforms', () => {
    const html = renderPackBody('en', pack, meta);
    expect(html.match(/DC-002/g)).toHaveLength(1);
    expect(html).toContain('RA1, RA2');
  });

  it('the file stands alone: styles inline, no scripts, a sortable name', () => {
    const doc = renderPackDocument('en', pack, meta);
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<style>');
    expect(doc).not.toMatch(/<script|<link /);
    expect(doc).toContain('<title>Monthly Pillar 1 review, 14 Nov 2026 (version 2)</title>');
    expect(packTitle('fr', 'quarterly_strategy_review', '2026-12-15', 1)).toBe('Revue stratégique trimestrielle, 15 déc. 2026 (version 1)');
    expect(packFileName('quarterly_strategy_review', '2026-12-15', 1, 'fr')).toBe('pillar1-qsr-2026-12-15-v1-fr.html');
  });
});

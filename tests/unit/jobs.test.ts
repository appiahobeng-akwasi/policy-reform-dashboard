// Build step 12: email text, run dates, the scheduler's secret and the public path.
import { describe, expect, it } from 'vitest';
import { isPublicPath } from '../../src/lib/auth/access';
import { dailyEmail, digestEmail, itemPath, reminderText } from '../../src/lib/jobs/messages';
import { defaultRunDate, isJob, isRunDate } from '../../src/lib/jobs/run';
import { secretMatches } from '../../src/lib/jobs/secret';

const overdue = { kind: 'overdue', objectType: 'milestone', objectId: 'MS-104', name: 'Validation <workshop>', detail: { level: 2, days: 7 } };

describe('reminder text', () => {
  it('says what is wrong and what to do, in English and French', () => {
    expect(reminderText('en', overdue)).toBe('Milestone MS-104: Validation <workshop> is 7 days overdue (escalation level 2). Update it or give a new date.');
    expect(reminderText('fr', overdue)).toBe("Jalon MS-104 : Validation <workshop> est en retard de 7 jours (niveau d'escalade 2). Mettez-le à jour ou donnez une nouvelle date.");
    expect(reminderText('en', { kind: 'due_soon', objectType: 'milestone', objectId: 'MS-1', name: null, detail: { due_date: '2026-11-14' } })).toBe('Milestone MS-1 is due on 14 Nov 2026.');
    expect(reminderText('fr', { kind: 'pathway_stalled', objectType: 'reform_stage', objectId: 'PT-003', name: 'Technical design', nameFr: 'Conception technique', detail: null })).toContain(
      'Étape du parcours PT-003 : Conception technique',
    );
  });

  it('links to the item, the pathway for a stage, nothing for a risk', () => {
    expect(itemPath(overdue)).toBe('/items/milestone/MS-104');
    expect(itemPath({ objectType: 'reform_stage', objectId: 'PT-003' }, 'RA1')).toBe('/pathway?reform=RA1');
    expect(itemPath({ objectType: 'risk', objectId: 'RK-001' })).toBeNull();
  });
});

describe('the daily email', () => {
  const email = dailyEmail('en', {
    name: 'Marie',
    reminders: [overdue],
    followUps: [{ kind: 'stale_item', objectType: 'milestone', objectId: 'MS-102', name: 'Decree', detail: { days: 40 }, owner: 'Jean Focal' }],
    baseUrl: 'https://dash.example',
  });

  it('bundles everything into one email with links', () => {
    expect(email.subject).toBe('Pillar 1 dashboard: items that need your attention');
    expect(email.text).toContain('Hello Marie,');
    expect(email.text).toContain('https://dash.example/items/milestone/MS-104');
    expect(email.text).toContain('For Jean Focal: Milestone MS-102: Decree has not been confirmed for 40 days.');
    expect(email.text).toContain('https://dash.example/on-behalf');
  });

  it('escapes names in the HTML', () => {
    expect(email.html).toContain('Validation &lt;workshop&gt;');
    expect(email.html).not.toContain('<workshop>');
  });
});

describe('the Monday digest', () => {
  it('lists the first items, says how many more, and adds the portfolio for admins', () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ objectType: 'milestone', objectId: `MS-10${i}`, name: `Item ${i}`, dueDate: '2026-12-01', daysOverdue: i === 0 ? 5 : 0, daysSinceUpdate: i === 1 ? 40 : 2 }));
    const email = digestEmail('fr', {
      name: 'the project lead',
      items: items.slice(0, 2),
      totalItems: 3,
      portfolio: { reforms: [{ reformId: 'RA1', overdue: 4, stale: 6, rag: 'red' }], newEscalations: 2, waitingApproval: 1, trainingSuggested: 0 },
      baseUrl: 'https://dash.example',
    });
    expect(email.subject).toBe('Tableau de bord du Pilier 1 : votre résumé de la semaine');
    expect(email.text).toContain('Jalon MS-100 : Item 0 : en retard de 5 jours');
    expect(email.text).toContain('Jalon MS-101 : Item 1 : non confirmé depuis 40 jours');
    expect(email.text).toContain('Autres éléments dans Mes éléments : 1.');
    expect(email.text).toContain('RA1 : 4 en retard, 6 non confirmés');
  });
});

describe('run dates are Kinshasa days (UTC+1)', () => {
  it('after 23:00 UTC it is already tomorrow in Kinshasa', () => {
    expect(defaultRunDate('daily', new Date('2026-11-04T22:59:00Z'))).toBe('2026-11-04');
    expect(defaultRunDate('daily', new Date('2026-11-04T23:00:00Z'))).toBe('2026-11-05');
  });

  it('month_end is the last day of the month just ended', () => {
    expect(defaultRunDate('month_end', new Date('2026-11-30T23:30:00Z'))).toBe('2026-11-30');
    expect(defaultRunDate('month_end', new Date('2027-01-01T05:00:00Z'))).toBe('2026-12-31');
    expect(defaultRunDate('month_end', new Date('2027-03-01T05:00:00Z'))).toBe('2027-02-28');
  });

  it('only known jobs and real dates are accepted', () => {
    expect(isJob('daily')).toBe(true);
    expect(isJob('drop table')).toBe(false);
    expect(isRunDate('2026-11-04')).toBe(true);
    expect(isRunDate('2026-13-04')).toBe(false);
    expect(isRunDate("2026-11-04'; --")).toBe(false);
  });
});

describe('the scheduler address', () => {
  it('needs the exact secret, and is closed when none is set', () => {
    expect(secretMatches('Bearer s3cret-value', 's3cret-value')).toBe(true);
    expect(secretMatches('Bearer s3cret-valuE', 's3cret-value')).toBe(false);
    expect(secretMatches('s3cret-value', 's3cret-value')).toBe(false);
    expect(secretMatches(null, 's3cret-value')).toBe(false);
    expect(secretMatches('Bearer ', undefined)).toBe(false);
    expect(secretMatches('Bearer ', '')).toBe(false);
  });

  it('is reachable without a session; other API paths are not', () => {
    expect(isPublicPath('/api/jobs/daily')).toBe(true);
    expect(isPublicPath('/api/uploads/x')).toBe(false);
    expect(isPublicPath('/admin/jobs')).toBe(false);
  });
});

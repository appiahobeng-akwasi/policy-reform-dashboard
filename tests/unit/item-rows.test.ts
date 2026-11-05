import { describe, expect, it } from 'vitest';
import { buildUpdateRow, cardFields, evidenceRow, formValue } from '../../src/lib/item-rows';

const item = {
  entity: 'milestone' as const,
  id: 'MS-008',
  version: '2026-11-03 19:01:36.841+00',
  record: { status: 'on_track', next_action: null, forecast_date: null, comments: 'Quick start', owner_person_id: 'p1' },
};

describe('update rows', () => {
  it('sends only the fields that changed, with the version the person saw', () => {
    const row = buildUpdateRow(item, { status: 'delayed', next_action: 'Call the minister', comments: 'Quick start', forecast_date: null }, cardFields('milestone', false));
    expect(row).toEqual({ entity: 'milestone', op: 'update', id: 'MS-008', fields: { status: 'delayed', next_action: 'Call the minister' }, base_updated_at: item.version });
  });

  it('treats blank and empty as the same', () => {
    expect(buildUpdateRow(item, { next_action: '', forecast_date: null }, cardFields('milestone', false)).fields).toEqual({});
  });

  it('a "nothing changed" confirmation has no fields', () => {
    expect(buildUpdateRow(item, {}, cardFields('milestone', false)).fields).toEqual({});
  });

  it('ignores fields the person may not change (owner without the right)', () => {
    expect(buildUpdateRow(item, { owner_person_id: 'p2' }, cardFields('milestone', false)).fields).toEqual({});
    expect(buildUpdateRow(item, { owner_person_id: 'p2' }, cardFields('milestone', true)).fields).toEqual({ owner_person_id: 'p2' });
  });

  it('reads form values: blank is null, progress is a number', () => {
    expect(formValue('next_action', '  ')).toBeNull();
    expect(formValue('progress_pct', '40')).toBe(40);
    expect(formValue('progress_pct', 'forty')).toBe('forty');
    expect(formValue('next_action', null)).toBeNull();
  });

  it('shows the fields each item type has', () => {
    expect(cardFields('milestone', false)).not.toContain('progress_pct');
    expect(cardFields('workstream', false)).toContain('progress_pct');
    expect(cardFields('activity', true)[0]).toBe('owner_person_id');
  });

  it('turns a checked upload into an evidence row linked to the item', () => {
    const row = evidenceRow(
      { upload_id: 'u1', file_name: 'minutes.pdf', file_path: 'evidence/2026/abc.pdf', file_sha256: 'abc', file_mime: 'application/pdf', file_bytes: 2048 },
      { title: 'Minutes of the working group', evidenceType: 'meeting_minutes', evidenceDate: '2026-11-05', sourceInstitution: 'Ministry of Agriculture' },
      { entity: 'milestone', id: 'MS-008' },
    );
    expect(row).toMatchObject({
      entity: 'evidence_item',
      op: 'create',
      fields: { file_path: 'evidence/2026/abc.pdf', access_level: 'restricted', file_bytes: 2048 },
      links: [{ object_type: 'milestone', object_id: 'MS-008' }],
      upload_id: 'u1',
    });
  });
});

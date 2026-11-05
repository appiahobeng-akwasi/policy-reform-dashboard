// Request body limits (decision 91): checked from Content-Length before anything is parsed.
import { describe, expect, it } from 'vitest';
import { bodyLimitFor, checkBody, FILE_FORM_LIMIT, FORM_LIMIT } from '../../src/lib/security/body-limit';

describe('bodyLimitFor', () => {
  it('reading has no limit', () => {
    expect(bodyLimitFor('GET', '/sign-in')).toBeNull();
    expect(bodyLimitFor('HEAD', '/api/lang')).toBeNull();
  });

  it('ordinary forms get the small limit, file forms the file limit, resumable uploads their own', () => {
    expect(bodyLimitFor('POST', '/api/lang')).toBe(FORM_LIMIT);
    expect(bodyLimitFor('POST', '/sign-in')).toBe(FORM_LIMIT);
    expect(bodyLimitFor('post', '/approvals/abc')).toBe(FORM_LIMIT);
    expect(bodyLimitFor('POST', '/uploads/new')).toBe(FILE_FORM_LIMIT);
    expect(bodyLimitFor('POST', '/uploads/0d6c2c1e-0000-4000-8000-000000000000')).toBe(FILE_FORM_LIMIT);
    expect(bodyLimitFor('POST', '/items/milestone/MS-101')).toBe(FILE_FORM_LIMIT);
    expect(bodyLimitFor('PATCH', '/api/uploads/incoming-abc')).toBeNull();
    expect(bodyLimitFor('POST', '/api/uploads')).toBeNull();
  });
});

describe('checkBody', () => {
  it('accepts a body within the limit', () => {
    expect(checkBody('POST', '/api/lang', '20')).toBe('ok');
    expect(checkBody('POST', '/api/lang', String(FORM_LIMIT))).toBe('ok');
  });

  it('refuses a body over the limit', () => {
    expect(checkBody('POST', '/api/lang', String(FORM_LIMIT + 1))).toBe('too_large');
    expect(checkBody('POST', '/uploads/new', String(FILE_FORM_LIMIT + 1))).toBe('too_large');
  });

  it('refuses a body of unknown length where a limit applies, never on reading', () => {
    expect(checkBody('POST', '/api/lang', null)).toBe('length_required');
    expect(checkBody('POST', '/api/lang', 'lots')).toBe('length_required');
    expect(checkBody('GET', '/api/lang', null)).toBe('ok');
    expect(checkBody('PATCH', '/api/uploads/x', null)).toBe('ok');
  });
});

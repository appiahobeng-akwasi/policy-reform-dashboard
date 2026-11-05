import { describe, expect, it } from 'vitest';
import { safeReturnPath } from '../../src/lib/http';

describe('safeReturnPath()', () => {
  it('keeps paths on this site', () => {
    expect(safeReturnPath('/')).toBe('/');
    expect(safeReturnPath('/pathway?reform=RA1')).toBe('/pathway?reform=RA1');
  });

  it.each([
    'https://evil.example/',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'pathway',
    '/line\nbreak',
    '',
    null,
    undefined,
  ])('sends %j back to the home page', (value) => {
    expect(safeReturnPath(value)).toBe('/');
  });
});

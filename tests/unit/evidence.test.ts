import { describe, expect, it } from 'vitest';
import { jpegName, needsShrinking, targetSize } from '../../src/lib/evidence/resize';
import { evidenceKey, sniff, zipEntryNames } from '../../src/lib/evidence/sniff';
import { docx, pdf, png, xlsx, zip } from '../support/files';

const bytes = (b: Buffer) => new Uint8Array(b);

describe('file type from its own bytes (docs/04: check magic bytes)', () => {
  it.each([
    ['a PDF', pdf(), 'pdf'],
    ['a PNG', png(4, 4), 'png'],
    ['a JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), 'jpg'],
    ['a Word file', docx(), 'docx'],
    ['an Excel file', xlsx(), 'xlsx'],
  ])('recognises %s', (_label, file, ext) => {
    const result = sniff(bytes(file));
    expect(result.ok && result.kind.ext).toBe(ext);
  });

  it.each([
    ['a Word file with macros', docx(true), 'macro'],
    ['an Excel file with macros', xlsx(true), 'macro'],
    ['a ZIP that is not Word or Excel', zip({ '[Content_Types].xml': '<x/>', 'other.xml': '<y/>' }), 'type'],
    ['a plain ZIP', zip({ 'notes.txt': 'hello' }), 'type'],
    ['an executable renamed .pdf', Buffer.from('MZ\x90\x00 not a pdf'), 'type'],
    ['an empty file', Buffer.alloc(0), 'empty'],
  ])('refuses %s', (_label, file, reason) => {
    const result = sniff(bytes(file));
    expect(result.ok ? 'accepted' : result.reason).toBe(reason);
  });

  it('lists ZIP entries', () => {
    expect(zipEntryNames(bytes(zip({ a: '1', 'b/c.xml': '2' })))).toEqual(['a', 'b/c.xml']);
    expect(zipEntryNames(bytes(Buffer.from('not a zip')))).toBeNull();
  });

  it('names stored files by fingerprint (decision 25)', () => {
    expect(evidenceKey('ab12', 'pdf', new Date('2026-11-20T10:00:00Z'))).toBe('evidence/2026/ab12.pdf');
  });
});

describe('making photos smaller (docs/01 section 5.1)', () => {
  it('fits the long edge to 1600 px and keeps the shape', () => {
    expect(targetSize(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(targetSize(1200, 4800)).toEqual({ width: 400, height: 1600 });
    expect(targetSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('shrinks large or non-JPEG images, and leaves small JPEGs and other files alone', () => {
    expect(needsShrinking('image/jpeg', 3_000_000, 4000, 3000)).toBe(true);
    expect(needsShrinking('image/png', 200_000, 800, 600)).toBe(true);
    expect(needsShrinking('image/jpeg', 300_000, 1200, 900)).toBe(false);
    expect(needsShrinking('application/pdf', 3_000_000, 0, 0)).toBe(false);
  });

  it('gives the smaller photo a .jpg name', () => {
    expect(jpegName('IMG_0042.PNG')).toBe('IMG_0042.jpg');
    expect(jpegName('photo')).toBe('photo.jpg');
  });
});

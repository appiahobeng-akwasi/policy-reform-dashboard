// What kind of file is this, judged from its own bytes, not its name (docs/04 security
// checklist: check magic bytes, reject macro-enabled files). Evidence types allowed by rule B15:
// pdf, jpg/jpeg, png, docx, xlsx.

export type EvidenceKind = { ext: 'pdf' | 'jpg' | 'png' | 'docx' | 'xlsx'; mime: string };
export type SniffResult = { ok: true; kind: EvidenceKind } | { ok: false; reason: 'type' | 'macro' | 'empty' };

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

const KINDS: Record<EvidenceKind['ext'], string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  png: 'image/png',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, i) => bytes[i] === byte);
}

/** File names inside a ZIP (Word and Excel files are ZIPs), from its central directory. */
export function zipEntryNames(bytes: Uint8Array): string[] | null {
  return zipEntries(bytes)?.map((entry) => entry.name) ?? null;
}

/** Names and unpacked sizes of the files inside a ZIP, from its central directory, without unpacking. */
export function zipEntries(bytes: Uint8Array): { name: string; size: number }[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: signature 0x06054b50, within the last 64 KB + 22 bytes.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const names: { name: string; size: number }[] = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    names.push({ name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)), size: view.getUint32(offset + 24, true) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

export function sniff(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  const kind = (ext: EvidenceKind['ext']): SniffResult => ({ ok: true, kind: { ext, mime: KINDS[ext] } });
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return kind('pdf'); // %PDF-
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return kind('jpg');
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return kind('png');
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const names = zipEntryNames(bytes);
    if (names === null || !names.includes('[Content_Types].xml')) return { ok: false, reason: 'type' };
    if (names.some((name) => /vbaProject\.bin$/i.test(name))) return { ok: false, reason: 'macro' };
    if (names.includes('word/document.xml')) return kind('docx');
    if (names.includes('xl/workbook.xml')) return kind('xlsx');
  }
  return { ok: false, reason: 'type' };
}

/** Storage key for a checked file (decision 25): evidence/{yyyy}/{sha256}.{ext}. */
export function evidenceKey(sha256: string, ext: string, now: Date = new Date()): string {
  return `evidence/${now.getUTCFullYear()}/${sha256}.${ext}`;
}

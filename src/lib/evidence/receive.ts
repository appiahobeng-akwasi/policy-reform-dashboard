// After a resumable upload finishes, the server checks the file before anyone can attach it:
// type from its own bytes, no macros, size, fingerprint. A good file is moved to its final
// place (named by fingerprint) and recorded in evidence_uploads; the raw upload is removed.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { storage } from '../platform/s3-storage';
import { evidenceKey, MAX_EVIDENCE_BYTES, sniff } from './sniff';

export type Received =
  | { ok: true; uploadId: string; fileName: string; mime: string; bytes: number; sha256: string }
  | { ok: false; reason: 'type' | 'macro' | 'empty' | 'size' | 'missing' };

export const INCOMING_PREFIX = 'incoming-';

export async function receiveUpload(db: pg.ClientBase, args: { storageId: string; fileName: string; userId: string }): Promise<Received> {
  if (!args.storageId.startsWith(INCOMING_PREFIX) || !/^[\w-]+$/.test(args.storageId)) return { ok: false, reason: 'missing' };
  if (!(await storage.exists(args.storageId))) return { ok: false, reason: 'missing' };
  let bytes: Uint8Array;
  try {
    bytes = await storage.read(args.storageId, MAX_EVIDENCE_BYTES);
  } catch (error) {
    if (error instanceof RangeError) {
      await storage.remove(args.storageId);
      return { ok: false, reason: 'size' };
    }
    throw error;
  }
  const sniffed = sniff(bytes);
  if (!sniffed.ok) {
    await storage.remove(args.storageId);
    return { ok: false, reason: sniffed.reason };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = evidenceKey(sha256, sniffed.kind.ext);
  // Written from the bytes already checked, not copied: the stored file is exactly what was checked.
  if (!(await storage.exists(key))) await storage.put(key, bytes, sniffed.kind.mime);
  await storage.remove(args.storageId);
  await storage.remove(`${args.storageId}.info`).catch(() => undefined);

  const fileName = args.fileName.replace(/[\\/]/g, '_').slice(0, 200) || `evidence.${sniffed.kind.ext}`;
  const { rows } = await db.query<{ upload_id: string }>(
    `insert into evidence_uploads (uploaded_by, file_name, file_path, file_sha256, file_mime, file_bytes)
     values ($1, $2, $3, $4, $5, $6) returning upload_id`,
    [args.userId, fileName, key, sha256, sniffed.kind.mime, bytes.length],
  );
  return { ok: true, uploadId: rows[0]!.upload_id, fileName, mime: sniffed.kind.mime, bytes: bytes.length, sha256 };
}

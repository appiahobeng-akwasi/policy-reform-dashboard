// Sending an update: save it as a submission (as the signed-in user, through row-level
// security), then run the gate on the server. A rejected submission is kept, and sending again
// reuses it, so attempts are numbered 1, 2, 3 in the data quality log.
import { randomBytes } from 'node:crypto';
import { notifyEnteredFor, runGateForSubmission } from './gate-server/run';
import type { GateResult, GateRow } from './gate/types';
import { INCOMING_PREFIX, receiveUpload, type Received } from './evidence/receive';
import { MAX_EVIDENCE_BYTES } from './evidence/sniff';
import { storage } from './platform/s3-storage';
import { asUser, inServerTransaction } from './server-db';

type User = NonNullable<App.Locals['user']>;

const REUSABLE = ['draft', 'rejected_by_gate', 'returned'];

/** An update entered for someone else (spec 01 section 5.3, decisions 30 to 32). */
export type OnBehalf = { personId: string; channel: string; receivedOn: string; note: string | null; instructionUploadId: string | null };

export const ON_BEHALF_CHANNELS = ['phone', 'whatsapp', 'meeting', 'email', 'letter', 'other'] as const;

export async function sendUpdate(
  user: User,
  rows: GateRow[],
  previousSubmissionId: string | null,
  onBehalf: OnBehalf | null = null,
): Promise<{ submissionId: string; result: GateResult }> {
  const payload = JSON.stringify({ rows });
  const route = onBehalf ? 'on_behalf' : 'web_form';
  const details = [onBehalf?.channel ?? null, onBehalf?.receivedOn ?? null, onBehalf?.note ?? null, onBehalf?.instructionUploadId ?? null];
  const submissionId = await asUser(user.claims, async (db) => {
    // A rejected attempt is reused only for the same kind of entry, for the same person.
    if (previousSubmissionId) {
      const reused = await db.query<{ submission_id: string }>(
        `update submissions set payload = $1, status = 'draft',
                on_behalf_channel = $6, on_behalf_received_on = $7, on_behalf_note = $8, instruction_upload_id = $9
          where submission_id = $2 and submitted_by = $3 and status = any ($4) and route = $5
            and on_behalf_of_person_id is not distinct from $10
          returning submission_id`,
        [payload, previousSubmissionId, user.userId, REUSABLE, route, ...details, onBehalf?.personId ?? null],
      );
      if (reused.rows[0]) return reused.rows[0].submission_id;
    }
    const created = await db.query<{ submission_id: string }>(
      `insert into submissions (route, submitted_by, entity, payload, on_behalf_of_person_id, on_behalf_channel, on_behalf_received_on, on_behalf_note, instruction_upload_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning submission_id`,
      [route, user.userId, rows[0]?.entity ?? null, payload, onBehalf?.personId ?? null, ...details],
    );
    return created.rows[0]!.submission_id;
  });
  const { result } = await inServerTransaction(async (db) => {
    const run = await runGateForSubmission(db, { submissionId, actingUserId: user.userId });
    if (run.result.outcome === 'pass' && onBehalf) await notifyEnteredFor(db, submissionId);
    return run;
  });
  return { submissionId, result };
}

/** The signed-in person's own checked uploads (row-level security keeps others out). */
export async function loadUploads(user: User, uploadIds: string[]) {
  if (uploadIds.length === 0) return [];
  return asUser(user.claims, async (db) => {
    const { rows } = await db.query<{ upload_id: string; file_name: string; file_path: string; file_sha256: string; file_mime: string; file_bytes: number }>(
      'select upload_id, file_name, file_path, file_sha256, file_mime, file_bytes from evidence_uploads where upload_id = any ($1::uuid[])',
      [uploadIds],
    );
    return rows;
  });
}

/** Without JavaScript the form posts the file itself; check it the same way as a resumable upload. */
export async function receiveFormFile(user: User, file: File): Promise<Received> {
  if (file.size === 0) return { ok: false, reason: 'empty' };
  if (file.size > MAX_EVIDENCE_BYTES) return { ok: false, reason: 'size' };
  const storageId = `${INCOMING_PREFIX}${randomBytes(16).toString('hex')}`;
  await storage.put(storageId, new Uint8Array(await file.arrayBuffer()), 'application/octet-stream');
  return inServerTransaction((db) => receiveUpload(db, { storageId, fileName: file.name, userId: user.userId }));
}

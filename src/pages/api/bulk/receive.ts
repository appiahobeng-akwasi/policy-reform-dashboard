import type { APIRoute } from 'astro';
import { BULK_ROLES, MAX_UPLOAD_BYTES, processUpload } from '../../../lib/bulk/process';
import { storageIdFromUrl, tusServer } from '../../../lib/evidence/tus';
import { storage } from '../../../lib/platform/s3-storage';
import { asUser } from '../../../lib/server-db';

// Called when the resumable upload of a workbook has finished: read it, check it, and say
// where its preview is.
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user || !BULK_ROLES.includes(user.role)) return Response.json({ ok: false }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { uploadUrl?: unknown; fileName?: unknown; previous?: unknown } | null;
  const storageId = typeof body?.uploadUrl === 'string' ? storageIdFromUrl(body.uploadUrl) : null;
  if (!storageId) return Response.json({ ok: false }, { status: 400 });
  const upload = await tusServer().datastore.getUpload(storageId).catch(() => null);
  if (!upload || upload.metadata?.['owner'] !== user.userId) return Response.json({ ok: false }, { status: 404 });
  if (upload.size === undefined || upload.offset !== upload.size) return Response.json({ ok: false }, { status: 409 });
  const bytes = await storage.read(storageId, MAX_UPLOAD_BYTES).catch(() => null);
  await storage.remove(storageId);
  await storage.remove(`${storageId}.info`).catch(() => undefined);
  if (!bytes) return Response.json({ ok: false, reason: 'size' }, { status: 413 });

  let previous: string | null = null;
  if (typeof body?.previous === 'string' && /^[0-9a-f-]{36}$/.test(body.previous)) {
    const own = await asUser(user.claims, (db) =>
      db.query("select 1 from submissions where submission_id = $1 and submitted_by = $2 and route = 'bulk_upload'", [body.previous, user.userId]),
    );
    if (own.rowCount) previous = body.previous as string;
  }
  const fileName = typeof body?.fileName === 'string' ? body.fileName : (upload.metadata?.['filename'] ?? 'upload.xlsx');
  const { submissionId } = await processUpload(user, { bytes, fileName }, previous);
  return Response.json({ ok: true, redirect: `/uploads/${submissionId}` });
};

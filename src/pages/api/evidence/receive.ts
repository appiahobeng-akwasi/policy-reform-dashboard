import type { APIRoute } from 'astro';
import { receiveUpload } from '../../../lib/evidence/receive';
import { storageIdFromUrl, tusServer } from '../../../lib/evidence/tus';
import { inServerTransaction } from '../../../lib/server-db';

// Called by the browser when a resumable upload has finished. Checks the file and returns the
// upload ID to attach to the update.
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return Response.json({ ok: false, reason: 'signed_out' }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { uploadUrl?: unknown; fileName?: unknown } | null;
  const storageId = typeof body?.uploadUrl === 'string' ? storageIdFromUrl(body.uploadUrl) : null;
  if (!storageId) return Response.json({ ok: false, reason: 'missing' }, { status: 400 });
  const upload = await tusServer().datastore.getUpload(storageId).catch(() => null);
  if (!upload || upload.metadata?.['owner'] !== user.userId) return Response.json({ ok: false, reason: 'missing' }, { status: 404 });
  if (upload.size === undefined || upload.offset !== upload.size) return Response.json({ ok: false, reason: 'unfinished' }, { status: 409 });
  const fileName = typeof body?.fileName === 'string' ? body.fileName : (upload.metadata?.['filename'] ?? '');
  const received = await inServerTransaction((db) => receiveUpload(db, { storageId, fileName, userId: user.userId }));
  return Response.json(received, { status: received.ok ? 200 : 422 });
};

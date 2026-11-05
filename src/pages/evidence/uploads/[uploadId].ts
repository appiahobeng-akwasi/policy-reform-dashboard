import type { APIRoute } from 'astro';
import { storage } from '../../../lib/platform/s3-storage';
import { asUser } from '../../../lib/server-db';

// Opens a file the person uploaded but that is not approved yet. Row-level security shows each
// person only their own uploads (and admins all).
export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  const id = params['uploadId'] ?? '';
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response(null, { status: 404 });
  const found = await asUser(locals.user.claims, async (db) => {
    const { rows } = await db.query<{ file_path: string; file_name: string }>('select file_path, file_name from evidence_uploads where upload_id = $1', [id]);
    return rows[0] ?? null;
  });
  if (!found) return new Response(null, { status: 404 });
  return new Response(null, { status: 302, headers: { location: await storage.signedDownloadUrl(found.file_path, found.file_name), 'cache-control': 'no-store' } });
};

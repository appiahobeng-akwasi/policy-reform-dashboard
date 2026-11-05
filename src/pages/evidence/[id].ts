import type { APIRoute } from 'astro';
import { storage } from '../../lib/platform/s3-storage';
import { asUser } from '../../lib/server-db';

// Opens an evidence file through a link that works for 60 seconds, and only for people whose
// row-level security lets them see this evidence (CLAUDE.md: restricted data by short-lived signed URLs).
export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  const found = await asUser(locals.user.claims, async (db) => {
    const { rows } = await db.query<{ file_path: string | null; title: string }>('select file_path, title from evidence_items where evidence_id = $1', [params['id']]);
    return rows[0] ?? null;
  });
  if (!found?.file_path) return new Response(null, { status: 404 });
  const extension = found.file_path.split('.').pop() ?? '';
  return new Response(null, {
    status: 302,
    headers: { location: await storage.signedDownloadUrl(found.file_path, `${found.title}.${extension}`), 'cache-control': 'no-store' },
  });
};

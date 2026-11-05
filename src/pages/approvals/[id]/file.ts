import type { APIRoute } from 'astro';
import { storage } from '../../../lib/platform/s3-storage';
import { asUser } from '../../../lib/server-db';

// Opens one of a submission's files for someone who may review it (decision 35): the database
// lists the files that person may open; the link works for 60 seconds. With inline=1, an image is
// sent through the app instead (decision 82), so the inbox can preview it on request without
// letting the page load images from the storage host. Only photos: never SVG or HTML.
const PREVIEW_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
export const GET: APIRoute = async ({ params, url, locals }) => {
  const user = locals.user;
  const id = params['id'] ?? '';
  const path = url.searchParams.get('path') ?? '';
  if (!user || !/^[0-9a-f-]{36}$/.test(id) || !path) return new Response(null, { status: 404 });
  const file = await asUser(user.claims, async (db) => {
    const { rows } = await db.query<{ label: string; file_path: string }>('select label, file_path from review_files($1) where file_path = $2', [id, path]);
    return rows[0] ?? null;
  });
  if (!file) return new Response(null, { status: 404 });
  const extension = (file.file_path.split('.').pop() ?? '').toLowerCase();
  const previewType = PREVIEW_TYPES[extension];
  if (url.searchParams.get('inline') === '1' && previewType) {
    try {
      const bytes = await storage.read(file.file_path, PREVIEW_MAX_BYTES);
      return new Response(new Blob([new Uint8Array(bytes)], { type: previewType }), {
        status: 200,
        headers: { 'content-type': previewType, 'content-disposition': 'inline', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
      });
    } catch (error) {
      // Too large to preview: fall back to the 60-second download link below.
      if (!(error instanceof RangeError)) throw error;
    }
  }
  const name = file.label.endsWith(`.${extension}`) ? file.label : `${file.label}.${extension}`;
  return new Response(null, { status: 302, headers: { location: await storage.signedDownloadUrl(file.file_path, name), 'cache-control': 'no-store' } });
};

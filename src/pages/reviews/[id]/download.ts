// The pack as one HTML file to keep or email: styles inline, no scripts, works offline.
import type { APIRoute } from 'astro';
import { getPack } from '../../../lib/reviews/pack';
import { documentPolicy } from '../../../lib/security/headers';
import { packFileName, renderPackDocument } from '../../../lib/reviews/render';

export const GET: APIRoute = async ({ locals, params }) => {
  const id = params['id'] ?? '';
  if (!locals.user || !/^[0-9a-f-]{36}$/.test(id)) return new Response(null, { status: 404 });
  const pack = await getPack(locals.user.claims, id);
  if (!pack) return new Response(null, { status: 404 });
  const html = renderPackDocument(locals.lang, pack.data, { version: pack.version, generatedAt: pack.generatedAt, generatedBy: pack.generatedBy });
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-disposition': `attachment; filename="${packFileName(pack.reviewType, pack.reviewDate, pack.version, locals.lang)}"`,
      'cache-control': 'private, no-store',
      'content-security-policy': documentPolicy(html),
    },
  });
};

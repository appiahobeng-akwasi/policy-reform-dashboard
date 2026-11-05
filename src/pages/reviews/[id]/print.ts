// The pack as a page of its own, laid out for A4, to print or save as PDF from the browser.
import type { APIRoute } from 'astro';
import { t } from '../../../i18n';
import { getPack } from '../../../lib/reviews/pack';
import { documentPolicy } from '../../../lib/security/headers';
import { renderPackDocument } from '../../../lib/reviews/render';

export const GET: APIRoute = async ({ locals, params }) => {
  const id = params['id'] ?? '';
  if (!locals.user || !/^[0-9a-f-]{36}$/.test(id)) return new Response(null, { status: 404 });
  const pack = await getPack(locals.user.claims, id);
  if (!pack) return new Response(null, { status: 404 });
  const html = renderPackDocument(locals.lang, pack.data, { version: pack.version, generatedAt: pack.generatedAt, generatedBy: pack.generatedBy }, t(locals.lang, 'reviews.print_note'));
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'content-security-policy': documentPolicy(html) } });
};

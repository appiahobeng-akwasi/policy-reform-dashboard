import type { APIRoute } from 'astro';
import { OWNER_HEADER, tusServer } from '../../../lib/evidence/tus';

// tus endpoints for resumable evidence uploads. The middleware has already checked sign-in
// (and MFA for admins); the uploader header is set here from the session, after removing any
// value the browser sent.
export const ALL: APIRoute = async ({ request, locals }) => {
  if (!locals.user) return new Response('Sign in first.\n', { status: 401 });
  const headers = new Headers(request.headers);
  headers.set(OWNER_HEADER, locals.user.userId);
  const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers, body: request.body, duplex: 'half' };
  return tusServer().handleWeb(new Request(request.url, init));
};

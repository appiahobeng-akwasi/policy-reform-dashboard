// How large a request body may be, checked from Content-Length before anything is read
// (decision 91). On Vercel the platform caps bodies too; on a plain Node host this is the only
// cap, so a stranger cannot make the server parse a huge form. Forms are small; the two forms
// that can carry a file without JavaScript (bulk upload and the update card) allow the 10 MB
// file limit plus the form around it. Resumable uploads set their own limit per piece (tus).

const KB = 1024;
const MB = 1024 * KB;
export const FORM_LIMIT = 64 * KB;
export const FILE_FORM_LIMIT = 11 * MB;

const WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

/** The largest body this request may have, or null when this check does not apply. */
export function bodyLimitFor(method: string, pathname: string): number | null {
  if (!WITH_BODY.has(method.toUpperCase())) return null;
  if (pathname === '/api/uploads' || pathname.startsWith('/api/uploads/')) return null;
  // Bulk upload (and its fixes form, which can carry many edited cells), the update card.
  if (pathname.startsWith('/uploads/') || pathname === '/api/bulk/receive' || pathname.startsWith('/items/')) return FILE_FORM_LIMIT;
  return FORM_LIMIT;
}

export type BodyVerdict = 'ok' | 'too_large' | 'length_required';

/**
 * Whether to accept a body of this declared length. Browsers always send Content-Length with a
 * form, so a body without one (chunked) is refused where a limit applies.
 */
export function checkBody(method: string, pathname: string, contentLength: string | null): BodyVerdict {
  const limit = bodyLimitFor(method, pathname);
  if (limit === null) return 'ok';
  if (contentLength === null || contentLength.trim() === '') return 'length_required';
  const length = Number(contentLength);
  if (!Number.isFinite(length) || length < 0) return 'length_required';
  return length > limit ? 'too_large' : 'ok';
}

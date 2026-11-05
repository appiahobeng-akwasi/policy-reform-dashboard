// Security headers on every response (spec 01 section 11, docs/04 section 6, decision 62). The
// Content Security Policy for pages comes from Astro (astro.config.mjs), which hashes its own
// scripts and styles; these are the other headers, and the policy for responses Astro does not
// render (the printable review pack).
import { createHash } from 'node:crypto';

const COMMON: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
};

export type HeaderOptions = {
  /** Over HTTPS, tell browsers to use HTTPS only (HSTS). */
  https: boolean;
  /** A signed-in page: never kept in shared caches. */
  personal: boolean;
};

/** The same response with the security headers added (copied if its headers cannot change). */
export function withSecurityHeaders(response: Response, options: HeaderOptions): Response {
  let out = response;
  try {
    out.headers.set('x-content-type-options', 'nosniff');
  } catch {
    out = new Response(response.body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) });
  }
  for (const [name, value] of Object.entries(COMMON)) out.headers.set(name, value);
  if (options.https) out.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  if (options.personal && !out.headers.has('cache-control')) out.headers.set('cache-control', 'private, no-store');
  return out;
}

/** A policy for a self-contained HTML document: only its own inline style, nothing else. */
export function documentPolicy(html: string): string {
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`);
  return [`default-src 'none'`, `style-src ${styles.join(' ') || "'none'"}`, `img-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`].join('; ');
}

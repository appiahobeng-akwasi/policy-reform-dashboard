// Which pages need a signed-in user, and when MFA must be completed first.

const PUBLIC_PATHS = new Set(['/', '/sign-in', '/auth/confirm', '/auth/sent', '/auth/sign-out', '/api/lang', '/404', '/healthz']);

export function isPublicPath(path: string): boolean {
  // Schedulers call /api/jobs/<name> with a shared secret, not a session (decision 50).
  if (path.startsWith('/api/jobs/')) return true;
  return PUBLIC_PATHS.has(path.length > 1 ? path.replace(/\/+$/, '') : path);
}

/** Pages a signed-in admin may open before finishing MFA: the MFA page itself and sign-out. */
export function isAllowedBeforeMfa(path: string): boolean {
  return path.startsWith('/auth/') || path === '/api/lang';
}

export function needsMfa(user: { mfaRequired: boolean; aal: string }): boolean {
  return user.mfaRequired && user.aal !== 'aal2';
}

/** Where to send someone who must sign in first, keeping the page they asked for. */
export function signInPath(next: string): string {
  return next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`;
}

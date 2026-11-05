// The address of a one-time sign-in link: the same shape as the link in the sign-in email
// (supabase/templates/sign_in.html), so /auth/confirm treats both the same way.

export function signInLinkUrl(appBaseUrl: string, tokenHash: string): string {
  if (!/^[\w-]+$/.test(tokenHash)) throw new Error('A sign-in token has only letters, digits, - and _.');
  const url = new URL('auth/confirm', appBaseUrl.replace(/\/+$/, '') + '/');
  url.searchParams.set('token_hash', tokenHash);
  url.searchParams.set('type', 'email');
  return url.toString();
}
